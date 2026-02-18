const express = require("express");
const nodemailer = require("nodemailer");
const cheerio = require("cheerio");
const path = require("path");
const XLSX = require("xlsx");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ═══ State ═══
let openRouterKey = "";
let selectedModel = "google/gemini-2.0-flash-001";
let appPassword = "";
const sentMessages = [];

// ═══ Visitor Intelligence State ═══
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const sites = new Map();
const visitors = new Map();
const eventBuffer = [];
const trackedLinks = new Map();
const activeSessions = new Map();
const geoCache = new Map();
const sseClients = new Map();
const EVENT_BUFFER_MAX = 50000;

function genId(prefix) {
  return prefix + "_" + crypto.randomBytes(6).toString("hex");
}

// Load persisted data
function loadViData() {
  try { const d = JSON.parse(fs.readFileSync(path.join(dataDir, "sites.json"), "utf8")); d.forEach(([k,v]) => sites.set(k,v)); } catch {}
  try { const d = JSON.parse(fs.readFileSync(path.join(dataDir, "visitors.json"), "utf8")); d.forEach(([k,v]) => visitors.set(k,v)); } catch {}
  try { const d = JSON.parse(fs.readFileSync(path.join(dataDir, "events.json"), "utf8")); eventBuffer.push(...d); } catch {}
  try { const d = JSON.parse(fs.readFileSync(path.join(dataDir, "tracked-links.json"), "utf8")); d.forEach(([k,v]) => trackedLinks.set(k,v)); } catch {}
}
loadViData();

// Debounced persistence
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(path.join(dataDir, "sites.json"), JSON.stringify([...sites])); } catch {}
    try { fs.writeFileSync(path.join(dataDir, "visitors.json"), JSON.stringify([...visitors])); } catch {}
    try { fs.writeFileSync(path.join(dataDir, "events.json"), JSON.stringify(eventBuffer.slice(-EVENT_BUFFER_MAX))); } catch {}
    try { fs.writeFileSync(path.join(dataDir, "tracked-links.json"), JSON.stringify([...trackedLinks])); } catch {}
    saveTimer = null;
  }, 30000);
}

// IP Geolocation via ip-api.com (free, no key required)
async function geolocateIP(ip) {
  if (!ip || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
    return { city: "Local", region: "Local", country: "Local", lat: 0, lng: 0, org: "Localhost" };
  }
  const cleanIp = ip.replace("::ffff:", "");
  if (geoCache.has(cleanIp)) return geoCache.get(cleanIp);
  try {
    const res = await fetch(`http://ip-api.com/json/${cleanIp}?fields=city,regionName,country,lat,lon,org,as`);
    const data = await res.json();
    const geo = { city: data.city || "", region: data.regionName || "", country: data.country || "", lat: data.lat || 0, lng: data.lon || 0, org: data.org || "", as: data.as || "" };
    geoCache.set(cleanIp, geo);
    return geo;
  } catch { return { city: "Unknown", region: "", country: "", lat: 0, lng: 0, org: "" }; }
}

// Engagement score
function computeEngagement(visitor) {
  let score = 0;
  const hoursSince = (Date.now() - new Date(visitor.lastSeen).getTime()) / 3600000;
  score += Math.max(0, 25 - hoursSince * 0.5);
  score += Math.min(25, visitor.totalSessions * 5);
  const avgPages = visitor.totalPageviews / Math.max(1, visitor.totalSessions);
  score += Math.min(15, avgPages * 3);
  const visitorEvents = eventBuffer.filter(e => e.visitorId === visitor.visitorId && e.type === "exit" && e.data?.scrollDepth);
  const avgScroll = visitorEvents.length > 0 ? visitorEvents.reduce((s, e) => s + e.data.scrollDepth, 0) / visitorEvents.length : 0;
  score += Math.min(10, avgScroll / 10);
  const hasHighIntent = eventBuffer.some(e => e.visitorId === visitor.visitorId && /contact|pricing|demo|services|consultation/i.test(e.data?.path || ""));
  if (hasHighIntent) score += 15;
  if (visitor.identified) score += 10;
  return Math.round(Math.min(100, score));
}

// Broadcast SSE event
function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const [id, res] of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(id); }
  }
}

// ═══ OpenRouter helper ═══
async function callOpenRouter(prompt, temperature = 0.7) {
  if (!openRouterKey) throw new Error("Set your OpenRouter API key first");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openRouterKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3456",
      "X-Title": "Belwo Lead Gen Tool",
    },
    body: JSON.stringify({
      model: selectedModel,
      messages: [{ role: "user", content: prompt }],
      temperature,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `OpenRouter API error: ${res.status}`);
  }

  const data = await res.json();
  return data.choices[0].message.content;
}

// ═══ Fetch a page's HTML safely ═══
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function fetchPage(url, timeoutMs = 10000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const html = await res.text();
    return html;
  } catch {
    return null;
  }
}

// ═══ Extract emails from HTML text ═══
function extractEmails(html) {
  const emails = new Set();

  // 1. mailto: links
  const mailtoRegex = /mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi;
  let match;
  while ((match = mailtoRegex.exec(html)) !== null) {
    emails.add(match[1].toLowerCase());
  }

  // 2. Emails in visible text (broad regex)
  const textEmailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  while ((match = textEmailRegex.exec(html)) !== null) {
    const email = match[0].toLowerCase();
    // Filter out fake/image/css emails
    if (!email.endsWith(".png") && !email.endsWith(".jpg") && !email.endsWith(".svg")
        && !email.endsWith(".gif") && !email.endsWith(".css") && !email.endsWith(".js")
        && !email.includes("example.com") && !email.includes("yoursite")
        && !email.includes("sentry") && !email.includes("webpack")
        && email.length < 60) {
      emails.add(email);
    }
  }

  return [...emails];
}

// ═══ Scrape company website for leadership info ═══
async function scrapeCompanyWebsite(url) {
  try {
    const html = await fetchPage(url);
    if (!html) return null;

    const $ = cheerio.load(html);
    const title = $("title").text().trim().slice(0, 200);
    const metaDesc = $('meta[name="description"]').attr("content")?.trim().slice(0, 300) || "";

    // Extract all text from about/team/leadership pages
    const allText = $("body").text();
    const emails = extractEmails(html);

    // Find common leadership page links
    const leadershipUrls = [];
    $("a").each((_, el) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text().trim().toLowerCase();
      const hrefLower = href.toLowerCase();

      const isLeadershipLink = ["about", "team", "leadership", "management", "executives", "contact"]
        .some(kw => text.includes(kw) || hrefLower.includes(kw));

      if (isLeadershipLink && href && !href.startsWith("#") && !href.startsWith("javascript")) {
        try {
          const resolved = new URL(href, url).href;
          leadershipUrls.push(resolved);
        } catch {}
      }
    });

    return {
      title,
      metaDesc,
      emails,
      leadershipUrls: [...new Set(leadershipUrls)].slice(0, 5),
      scraped: true,
    };
  } catch {
    return null;
  }
}

// ═══ ROUTES ═══

// Save config
app.post("/api/config", (req, res) => {
  const { apiKey, gmailAppPassword, model } = req.body;
  if (!apiKey) return res.status(400).json({ error: "OpenRouter API key required" });
  openRouterKey = apiKey;
  appPassword = gmailAppPassword || "";
  if (model) selectedModel = model;
  res.json({ success: true, message: `Configuration saved. Model: ${selectedModel}` });
});

// Get available models
app.get("/api/models", async (req, res) => {
  const models = [
    { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", cost: "$" },
    { id: "google/gemini-2.5-pro-preview", name: "Gemini 2.5 Pro", cost: "$$" },
    { id: "anthropic/claude-opus-4.5", name: "Claude Opus 4.5", cost: "$$$" },
    { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", cost: "$$" },
    { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", cost: "$" },
    { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", cost: "$" },
    { id: "openai/gpt-4o", name: "GPT-4o", cost: "$$" },
    { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", cost: "$" },
    { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3", cost: "$" },
  ];
  res.json({ models, selected: selectedModel });
});

// ═══ Industry & Role Categories ═══
const TARGET_INDUSTRIES = {
  "banking": {
    label: "Banking & Financial Services",
    description: "Banks, credit unions, fintech companies needing regulatory compliance and customer communication",
    keywords: "banking, financial services, credit union, fintech, wealth management, investment"
  },
  "insurance": {
    label: "Insurance Companies",
    description: "Insurance providers needing omnichannel policy communications",
    keywords: "insurance, life insurance, property insurance, health insurance, underwriting"
  },
  "healthcare": {
    label: "Healthcare & Medical",
    description: "Hospitals, clinics, healthcare systems needing patient communications",
    keywords: "healthcare, hospital, medical center, clinic, health system, patient care"
  },
  "government": {
    label: "Government & Public Sector",
    description: "Government agencies, municipalities needing citizen engagement",
    keywords: "government, public sector, municipality, state agency, federal, local government"
  },
  "utilities": {
    label: "Utilities & Telecom",
    description: "Utility companies, telecom providers with high-volume customer communications",
    keywords: "utility, electricity, water, gas, telecom, telecommunications, broadband"
  },
  "enterprise": {
    label: "Large Enterprises",
    description: "Fortune 500, large corporations needing document automation",
    keywords: "enterprise, corporation, fortune 500, large company, multinational"
  },
  "printing": {
    label: "Printing & Print Services",
    description: "Commercial printers, print service providers, and print management companies needing output management and digital transformation",
    keywords: "printing, commercial print, print services, print management, digital print, transactional print, direct mail, print production, print workflow"
  }
};

const TARGET_ROLES = [
  "Chief Information Officer (CIO)",
  "Chief Technology Officer (CTO)",
  "VP of IT",
  "IT Director",
  "Director of Digital Transformation",
  "Head of Customer Experience",
  "VP of Customer Operations",
  "Director of Communications",
  "Chief Digital Officer",
  "VP of Technology",
  "Head of IT Infrastructure",
  "Director of Enterprise Applications"
];

// Get industries
app.get("/api/industries", (req, res) => {
  const industries = Object.entries(TARGET_INDUSTRIES).map(([id, data]) => ({
    id,
    label: data.label,
    description: data.description,
  }));
  res.json({ industries });
});

// Previously searched companies to avoid repeats
let previouslySearched = new Set();

// ═══ Find REAL leads (decision makers at target companies) ═══
app.post("/api/find-leads", async (req, res) => {
  const { industry, customKeywords, roleFilter, page } = req.body;
  const searchPage = page || 1;

  try {
    const industryData = TARGET_INDUSTRIES[industry] || TARGET_INDUSTRIES["enterprise"];
    const searchKeywords = customKeywords || industryData.keywords;

    // Build exclusion list
    const excludeList = previouslySearched.size > 0
      ? `\n\nDO NOT include any of these companies (already searched): ${[...previouslySearched].join(", ")}`
      : "";

    const randomSeed = Math.floor(Math.random() * 100000);

    const prompt = `You are a B2B lead generation expert. Find REAL companies and their decision-makers for Belwo's CCM consulting services.

ABOUT BELWO:
Belwo (www.belwo.com) is a Customer Communications Management (CCM) consulting firm with 20 years of experience. They help enterprises modernize customer communication infrastructure through:
- CCM platform implementation (Quadient, OpenText, SmartComm, Solimar)
- Document automation and output management
- Application migration and system integration
- Managed services for customer communications

TARGET INDUSTRY: ${industryData.label}
KEYWORDS: ${searchKeywords}
SEARCH PAGE: ${searchPage} (provide DIFFERENT results than previous pages)
RANDOM SEED: ${randomSeed}

TARGET ROLES: ${TARGET_ROLES.join(", ")}

CRITICAL RULES:
1. ONLY suggest REAL companies that ACTUALLY EXIST with real websites
2. For each company, identify 2-3 REAL decision-makers who would buy CCM solutions
3. Include their ACTUAL job titles (CIO, CTO, VP IT, Director of Digital Transformation, etc.)
4. These should be people who own: IT infrastructure, customer communications, digital transformation, enterprise applications
5. DO NOT invent names or emails - use realistic formats based on company domain
6. Include company size, location, and why they need CCM solutions
7. Vary between large enterprises, mid-market, and growing companies
${excludeList}

Generate exactly 12 REAL leads (decision-makers at companies). For each provide:
1. company: Actual company name
2. companyWebsite: Real company website URL (with https://)
3. industry: Specific industry (e.g., "Regional Bank", "Health Insurance", "Electric Utility")
4. companySize: Employee count or category (e.g., "5000+ employees", "Mid-market 500-2000")
5. location: City, State/Country
6. name: Decision maker's full name (or realistic placeholder like "CIO - [Company Name]")
7. title: Actual job title
8. linkedinUrl: LinkedIn profile URL (format: https://www.linkedin.com/in/firstname-lastname or company page)
9. email: Email in format firstname.lastname@companydomain.com (or common format)
10. painPoint: Specific CCM/communication challenge they likely face
11. relevance: Score 1-10 for fit with Belwo's services

Return ONLY valid JSON array. No markdown, no code blocks.
[{"company":"...","companyWebsite":"...","industry":"...","companySize":"...","location":"...","name":"...","title":"...","linkedinUrl":"...","email":"...","painPoint":"...","relevance":8}]`;

    const text = await callOpenRouter(prompt, 0.6);
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    let leads = JSON.parse(cleaned);

    // Track searched companies
    leads.forEach(l => {
      try { previouslySearched.add(l.company); } catch {}
    });

    // Step 2: Scrape company websites for additional emails
    const enriched = await Promise.all(
      leads.map(async (lead) => {
        const siteData = await scrapeCompanyWebsite(lead.companyWebsite);
        const scrapedEmails = siteData?.emails || [];

        return {
          ...lead,
          verified: !!siteData,
          scrapedEmails,
          additionalInfo: siteData,
        };
      })
    );

    // Sort by relevance
    const sorted = enriched.sort((a, b) => (b.relevance || 0) - (a.relevance || 0));

    res.json({
      leads: sorted,
      industry: industryData.label,
      page: searchPage,
      totalPreviouslySearched: previouslySearched.size,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset search history
app.post("/api/reset-search", (req, res) => {
  previouslySearched.clear();
  res.json({ success: true, message: "Search history cleared." });
});

// ═══ Generate PERSONALIZED outreach message ═══
app.post("/api/generate-message", async (req, res) => {
  const { lead, messageType, senderName } = req.body;
  // messageType: "linkedin" or "email"

  try {
    const prompt = `You are writing a ${messageType === "linkedin" ? "LinkedIn connection request message" : "cold email"} for Belwo's CCM consulting services.

SENDER: ${senderName || "Business Development @ Belwo"}
SENDER COMPANY: Belwo (www.belwo.com)
- 20 years in Customer Communications Management (CCM)
- 200+ consultants, 100+ clients globally
- Partners: Quadient, OpenText, SmartComm, Solimar, Compart
- Services: CCM implementation, document automation, output management, system integration

RECIPIENT: ${lead.name}
TITLE: ${lead.title}
COMPANY: ${lead.company} (${lead.companyWebsite})
INDUSTRY: ${lead.industry}
COMPANY SIZE: ${lead.companySize}
LOCATION: ${lead.location}
PAIN POINT: ${lead.painPoint}

${messageType === "linkedin" ? `
WRITE A LINKEDIN MESSAGE (300 characters max for connection request):
1. Keep it SHORT - LinkedIn limits to 300 characters
2. Mention their role/company specifically
3. Brief value prop relevant to their pain point
4. Friendly, professional tone
5. Clear CTA (e.g., "Would love to connect and share insights")

Return ONLY JSON: {"message":"..."}
` : `
WRITE A COLD EMAIL:
1. SUBJECT LINE: Curiosity-driven, relevant to their role (no spam triggers)
2. OPENING: Personalize - reference their company, industry, or recent news
3. THE PITCH: Explain how Belwo solves their specific pain point
   - Be specific about CCM solutions
   - Mention 1-2 relevant clients/case studies if applicable
   - Focus on THEIR business outcomes (efficiency, compliance, customer experience)
4. CREDIBILITY: Brief mention of 20 years, 100+ clients, or key partnerships
5. CTA: One clear, low-friction ask (15-min call, demo, whitepaper)
6. LENGTH: 150-200 words max
7. TONE: Professional peer-to-peer, consultative (not salesy)

Return ONLY JSON: {"subject":"...","body":"..."}
`}

No markdown, no code blocks.`;

    const text = await callOpenRouter(prompt, 0.8);
    const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const message = JSON.parse(cleaned);
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: "Message generation failed: " + err.message });
  }
});

// Save generated message to tracking
app.post("/api/save-message", async (req, res) => {
  const { lead, message, messageType, status } = req.body;
  sentMessages.push({
    lead,
    message,
    messageType,
    status,
    savedAt: new Date().toISOString(),
  });
  res.json({ success: true });
});

// Get saved messages
app.get("/api/saved-messages", (req, res) => {
  res.json({ messages: sentMessages });
});

// ═══ EXPORT TO EXCEL ═══

// Export leads to Excel
app.post("/api/export-leads", (req, res) => {
  try {
    const { leads } = req.body;

    if (!leads || !leads.length) {
      return res.status(400).json({ error: "No leads to export" });
    }

    // Prepare data for Excel
    const excelData = leads.map(lead => ({
      "Company": lead.company || "",
      "Decision Maker": lead.name || "",
      "Title": lead.title || "",
      "Email": lead.email || "",
      "LinkedIn URL": lead.linkedinUrl || "",
      "Company Website": lead.companyWebsite || "",
      "Industry": lead.industry || "",
      "Company Size": lead.companySize || "",
      "Location": lead.location || "",
      "Pain Point": lead.painPoint || "",
      "Relevance Score": lead.relevance || "",
      "Verified": lead.verified ? "Yes" : "No",
      "Additional Emails": (lead.scrapedEmails || []).join(", "),
      "Contact Pages Checked": lead.additionalInfo?.contactPagesVisited?.length || 0,
    }));

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(excelData);

    // Set column widths
    ws['!cols'] = [
      { wch: 30 }, // Company
      { wch: 25 }, // Decision Maker
      { wch: 35 }, // Title
      { wch: 35 }, // Email
      { wch: 50 }, // LinkedIn URL
      { wch: 40 }, // Company Website
      { wch: 25 }, // Industry
      { wch: 20 }, // Company Size
      { wch: 25 }, // Location
      { wch: 60 }, // Pain Point
      { wch: 15 }, // Relevance Score
      { wch: 10 }, // Verified
      { wch: 50 }, // Additional Emails
      { wch: 20 }, // Contact Pages Checked
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Leads");

    // Generate buffer
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    // Set headers for download
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=Belwo_Leads_${new Date().toISOString().split('T')[0]}.xlsx`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: "Export failed: " + err.message });
  }
});

// Export messages to Excel
app.post("/api/export-messages", (req, res) => {
  try {
    if (!sentMessages || !sentMessages.length) {
      return res.status(400).json({ error: "No messages to export" });
    }

    // Prepare data for Excel
    const excelData = sentMessages.map(msg => ({
      "Lead Name": msg.lead?.name || "",
      "Company": msg.lead?.company || "",
      "Title": msg.lead?.title || "",
      "Email": msg.lead?.email || "",
      "LinkedIn URL": msg.lead?.linkedinUrl || "",
      "Industry": msg.lead?.industry || "",
      "Message Type": msg.messageType === "linkedin" ? "LinkedIn" : "Email",
      "Subject": msg.message?.subject || "N/A",
      "Message Body": msg.messageType === "linkedin" ? msg.message?.message : msg.message?.body,
      "Generated At": new Date(msg.savedAt).toLocaleString(),
      "Status": msg.status || "generated",
    }));

    // Create workbook and worksheet
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(excelData);

    // Set column widths
    ws['!cols'] = [
      { wch: 25 }, // Lead Name
      { wch: 30 }, // Company
      { wch: 35 }, // Title
      { wch: 35 }, // Email
      { wch: 50 }, // LinkedIn URL
      { wch: 25 }, // Industry
      { wch: 15 }, // Message Type
      { wch: 50 }, // Subject
      { wch: 80 }, // Message Body
      { wch: 20 }, // Generated At
      { wch: 15 }, // Status
    ];

    XLSX.utils.book_append_sheet(wb, ws, "Messages");

    // Generate buffer
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    // Set headers for download
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=Belwo_Messages_${new Date().toISOString().split('T')[0]}.xlsx`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: "Export failed: " + err.message });
  }
});

// ═══ PAIN POINT ANALYSIS ═══

function cleanJsonResponse(text) {
  return text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
}

function buildResearchPrompt(companyName, industryData, website, context) {
  return `You are a B2B research analyst specializing in Customer Communications Management (CCM) for ${industryData.label}.

COMPANY TO RESEARCH: ${companyName}
INDUSTRY: ${industryData.label}
${website ? `WEBSITE: ${website}` : ""}
${context ? `ADDITIONAL CONTEXT: ${context}` : ""}

ABOUT BELWO:
Belwo is a CCM consulting firm specializing in:
- CCM platform implementation (Quadient, OpenText, SmartComm, Solimar, Compart)
- Document automation and output management
- Application migration and system integration
- Managed services for customer communications

Provide detailed analysis covering:

1. Industry Landscape: Current trends in ${industryData.label}, regulatory challenges, digital transformation pressures, customer communication challenges specific to this industry.

2. Company Profile: Company size, market position, customer base, known technology infrastructure, recent initiatives or transformation projects.

3. Communication Challenges: Volume and types of customer communications they handle, compliance and regulatory communication requirements, multi-channel communication needs (print, email, SMS, web), document generation and personalization requirements.

4. Technology Gaps: Legacy systems and modernization needs, integration challenges, scalability and efficiency concerns, omnichannel delivery limitations.

Write a comprehensive 4-6 paragraph research summary. Be specific and actionable. Focus on insights that would help Belwo position their CCM solutions.

Return ONLY the research text. No JSON, no markdown formatting, no code blocks.`;
}

function buildPainPointsPrompt(companyName, industryData, research, context) {
  return `You are a CCM pain point expert. Based on the research below, identify the TOP 5 most critical Customer Communications Management pain points for ${companyName}.

COMPANY: ${companyName}
INDUSTRY: ${industryData.label}
${context ? `CONTEXT: ${context}` : ""}

RESEARCH FINDINGS:
${research}

BELWO'S CCM SOLUTIONS:
- Quadient, OpenText, SmartComm platform implementations
- Document automation and template management
- Output management (print, email, SMS, web)
- System integration and migration
- Compliance and regulatory communication
- Personalization and customer experience

For each pain point, provide:
1. title (string): Short, impactful title (4-6 words)
2. severity (string): "High", "Medium", or "Critical"
3. icon (string): Single emoji representing the pain point
4. description (string): Detailed description of the pain point (2-3 sentences)
5. belwoSolution (string): How Belwo's CCM solutions specifically address this (2-3 sentences)
6. businessImpact (string): Quantifiable business impact if not addressed (1 sentence)

Return EXACTLY this JSON structure (no markdown, no code blocks):
{"painPoints":[{"title":"string","severity":"High|Medium|Critical","icon":"emoji","description":"string","belwoSolution":"string","businessImpact":"string"}]}`;
}

function buildMessagingPrompt(companyName, industryData, painPoints, context) {
  return `You are a B2B messaging strategist. Create 3 personalized messaging angles for Belwo to approach ${companyName}.

COMPANY: ${companyName}
INDUSTRY: ${industryData.label}
${context ? `CONTEXT: ${context}` : ""}

IDENTIFIED PAIN POINTS:
${JSON.stringify(painPoints, null, 2)}

BELWO'S VALUE PROPOSITION:
- 20 years CCM experience, 200+ consultants, 100+ clients
- Expertise in ${industryData.label} compliance and regulations
- Partners: Quadient, OpenText, SmartComm, Solimar, Compart

For each messaging angle, provide:
1. headline (string): Compelling value proposition headline (6-10 words)
2. description (string): Explanation of the angle and why it resonates (2-3 sentences)
3. keyPoints (array of 3-4 strings): Bullet points to emphasize in outreach

Create angles that tie directly to the identified pain points, emphasize business outcomes, reference ${industryData.label}-specific challenges, and are differentiated from each other.

Return EXACTLY this JSON structure (no markdown, no code blocks):
{"angles":[{"headline":"string","description":"string","keyPoints":["string","string","string"]}]}`;
}

function buildTemplatesPrompt(companyName, industryData, painPoints, messaging, context) {
  return `You are a B2B outreach copywriter. Create 3 outreach templates for ${companyName} based on the analysis.

COMPANY: ${companyName}
INDUSTRY: ${industryData.label}
${context ? `CONTEXT: ${context}` : ""}

PAIN POINTS:
${JSON.stringify(painPoints, null, 2)}

MESSAGING ANGLES:
${JSON.stringify(messaging, null, 2)}

Create 3 templates:

1. LinkedIn Connection Message (300 characters max)
   - Type: "LinkedIn Message"
   - id: "linkedin"
   - subject: null
   - Body: Short, personalized connection request

2. Initial Cold Email (150-200 words)
   - Type: "Cold Email"
   - id: "email-initial"
   - subject: Curiosity-driven, relevant subject line
   - Body: Personalized email referencing a specific pain point

3. Follow-up Email (100-150 words)
   - Type: "Follow-up Email"
   - id: "email-followup"
   - subject: Value-added follow-up subject
   - Body: Share insight, case study, or whitepaper offer

RULES:
- Reference ${companyName} specifically
- Mention ${industryData.label} challenges authentically
- Include specific pain points from the analysis
- Professional, consultative tone (not salesy)
- Clear, single CTA per template
- Use "Belwo" and include www.belwo.com
- Sender is "Business Development @ Belwo"

Return EXACTLY this JSON structure (no markdown, no code blocks):
{"templates":[{"id":"linkedin","type":"LinkedIn Message","subject":null,"body":"string"},{"id":"email-initial","type":"Cold Email","subject":"string","body":"string"},{"id":"email-followup","type":"Follow-up Email","subject":"string","body":"string"}]}`;
}

app.post("/api/analyze-painpoints", async (req, res) => {
  const { companyName, industry, website, context } = req.body;

  if (!companyName || !industry) {
    return res.status(400).json({ error: "Company name and industry are required" });
  }

  try {
    const industryData = TARGET_INDUSTRIES[industry] || TARGET_INDUSTRIES["enterprise"];

    // Step 1: Industry & Company Research
    const research = await callOpenRouter(buildResearchPrompt(companyName, industryData, website, context), 0.7);

    // Step 2: Pain Point Identification
    const painPointsText = await callOpenRouter(buildPainPointsPrompt(companyName, industryData, research, context), 0.6);
    const painPoints = JSON.parse(cleanJsonResponse(painPointsText));

    // Step 3: Messaging Angles
    const messagingText = await callOpenRouter(buildMessagingPrompt(companyName, industryData, painPoints, context), 0.7);
    const messaging = JSON.parse(cleanJsonResponse(messagingText));

    // Step 4: Outreach Templates
    const templatesText = await callOpenRouter(buildTemplatesPrompt(companyName, industryData, painPoints, messaging, context), 0.8);
    const templates = JSON.parse(cleanJsonResponse(templatesText));

    res.json({
      companyName,
      industry: industryData.label,
      research,
      painPoints,
      messaging,
      templates,
      analyzedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: "Pain point analysis failed: " + err.message });
  }
});

// Export pain point analysis to Excel
app.post("/api/export-analysis", (req, res) => {
  try {
    const { company, industry, analyzedAt, research, painPoints, messagingAngles, templates } = req.body;

    if (!company || !painPoints) {
      return res.status(400).json({ error: "No analysis data to export" });
    }

    const wb = XLSX.utils.book_new();

    // Sheet 1: Overview
    const overviewData = [
      ["Pain Point Analysis Report"],
      [""],
      ["Company", company],
      ["Industry", industry],
      ["Analyzed", analyzedAt],
      [""],
      ["Research Summary"],
      [research],
    ];
    const wsOverview = XLSX.utils.aoa_to_sheet(overviewData);
    wsOverview["!cols"] = [{ wch: 20 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, wsOverview, "Overview");

    // Sheet 2: Pain Points
    const painPointsData = (painPoints || []).map(pp => ({
      "Title": pp.title,
      "Severity": pp.severity,
      "Description": pp.description,
      "Belwo Solution": pp.belwoSolution,
      "Business Impact": pp.businessImpact,
    }));
    const wsPainPoints = XLSX.utils.json_to_sheet(painPointsData);
    wsPainPoints["!cols"] = [{ wch: 30 }, { wch: 15 }, { wch: 50 }, { wch: 50 }, { wch: 40 }];
    XLSX.utils.book_append_sheet(wb, wsPainPoints, "Pain Points");

    // Sheet 3: Messaging Angles
    const messagingData = (messagingAngles || []).map(angle => ({
      "Headline": angle.headline,
      "Description": angle.description,
      "Key Points": (angle.keyPoints || []).join(" | "),
    }));
    const wsMessaging = XLSX.utils.json_to_sheet(messagingData);
    wsMessaging["!cols"] = [{ wch: 40 }, { wch: 60 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, wsMessaging, "Messaging Angles");

    // Sheet 4: Templates
    const templatesData = (templates || []).map(t => ({
      "Type": t.type,
      "Subject": t.subject || "N/A",
      "Body": t.body,
    }));
    const wsTemplates = XLSX.utils.json_to_sheet(templatesData);
    wsTemplates["!cols"] = [{ wch: 20 }, { wch: 50 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, wsTemplates, "Templates");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=Belwo_PainPoint_${company.replace(/\s/g, "_")}_${new Date().toISOString().split("T")[0]}.xlsx`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: "Export failed: " + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ═══ VISITOR INTELLIGENCE MODULE ═══
// ═══════════════════════════════════════════════════════════════

// CORS for tracking endpoint (cross-origin requests from any website)
app.use("/api/track", (req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── Site Management ───

app.post("/api/vi/sites", (req, res) => {
  const { name, domain } = req.body;
  if (!name || !domain) return res.status(400).json({ error: "Name and domain are required" });

  const siteId = genId("s");
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const site = {
    siteId,
    name,
    domain: domain.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    createdAt: new Date().toISOString(),
    trackingSnippet: `<script src="${baseUrl}/tracker.js?sid=${siteId}" async></script>`
  };
  sites.set(siteId, site);
  scheduleSave();
  res.json({ success: true, site });
});

app.get("/api/vi/sites", (req, res) => {
  const result = [...sites.values()].map(site => {
    const siteEvents = eventBuffer.filter(e => e.siteId === site.siteId);
    const siteVisitors = [...visitors.values()].filter(v => v.siteIds && v.siteIds.includes(site.siteId));
    return { ...site, visitorCount: siteVisitors.length, pageviewCount: siteEvents.filter(e => e.type === "pageview").length };
  });
  res.json({ sites: result });
});

app.delete("/api/vi/sites/:siteId", (req, res) => {
  sites.delete(req.params.siteId);
  scheduleSave();
  res.json({ success: true });
});

// ─── Event Collection (called by tracker.js) ───

app.post("/api/track", async (req, res) => {
  res.sendStatus(204); // Respond immediately

  const { siteId, fingerprint: fp, sessionId, type, timestamp, data } = req.body;
  if (!siteId || !fp || !type) return;

  // Get visitor IP
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || req.socket?.remoteAddress || "";

  // Find or create visitor
  let visitor = null;
  for (const v of visitors.values()) {
    if (v.fingerprintHash === fp) { visitor = v; break; }
  }

  if (!visitor) {
    const geo = await geolocateIP(ip);
    const visitorId = genId("v");
    visitor = {
      visitorId,
      fingerprintHash: fp,
      identified: false,
      identity: null,
      firstSeen: timestamp || new Date().toISOString(),
      lastSeen: timestamp || new Date().toISOString(),
      totalSessions: 1,
      totalPageviews: 0,
      engagementScore: 0,
      geo: { ip, ...geo },
      company: { name: geo.org || "", domain: "" },
      device: {
        browser: extractBrowser(req.headers["user-agent"] || ""),
        os: extractOS(req.headers["user-agent"] || ""),
        deviceType: data?.deviceType || "desktop",
        screenResolution: (data?.screenWidth && data?.screenHeight) ? `${data.screenWidth}x${data.screenHeight}` : ""
      },
      siteIds: [siteId],
      sessions: [sessionId]
    };
    visitors.set(visitorId, visitor);
  } else {
    visitor.lastSeen = timestamp || new Date().toISOString();
    if (!visitor.sessions.includes(sessionId)) {
      visitor.sessions.push(sessionId);
      visitor.totalSessions++;
    }
    if (!visitor.siteIds) visitor.siteIds = [];
    if (!visitor.siteIds.includes(siteId)) visitor.siteIds.push(siteId);
  }

  if (type === "pageview") visitor.totalPageviews++;

  // Check for tracked link identification
  if (data?.trackingId) {
    const tl = trackedLinks.get(data.trackingId);
    if (tl && tl.leadInfo) {
      visitor.identified = true;
      visitor.identity = { ...tl.leadInfo, identifiedAt: new Date().toISOString(), source: tl.messageType };
      tl.clicks = (tl.clicks || 0) + 1;
      tl.lastClicked = new Date().toISOString();
    }
  }

  // Compute engagement
  visitor.engagementScore = computeEngagement(visitor);

  // Store event
  const event = {
    eventId: genId("e"),
    siteId,
    visitorId: visitor.visitorId,
    sessionId,
    type,
    timestamp: timestamp || new Date().toISOString(),
    data: data || {}
  };
  eventBuffer.push(event);
  if (eventBuffer.length > EVENT_BUFFER_MAX) eventBuffer.splice(0, eventBuffer.length - EVENT_BUFFER_MAX);

  // Update active sessions
  activeSessions.set(visitor.visitorId, { timestamp: Date.now(), page: data?.path || data?.url || "", siteId });

  // Broadcast to SSE clients
  broadcastSSE({
    type: "event",
    event: { ...event, visitor: { visitorId: visitor.visitorId, identified: visitor.identified, identity: visitor.identity, geo: visitor.geo, device: visitor.device } }
  });

  scheduleSave();
});

// Simple UA parsing helpers
function extractBrowser(ua) {
  if (ua.includes("Firefox/")) return "Firefox " + (ua.match(/Firefox\/(\d+)/)?.[1] || "");
  if (ua.includes("Edg/")) return "Edge " + (ua.match(/Edg\/(\d+)/)?.[1] || "");
  if (ua.includes("Chrome/")) return "Chrome " + (ua.match(/Chrome\/(\d+)/)?.[1] || "");
  if (ua.includes("Safari/") && !ua.includes("Chrome")) return "Safari " + (ua.match(/Version\/(\d+)/)?.[1] || "");
  return "Other";
}

function extractOS(ua) {
  if (ua.includes("Windows NT 10")) return "Windows 10/11";
  if (ua.includes("Windows")) return "Windows";
  if (ua.includes("Mac OS X")) return "macOS";
  if (ua.includes("Linux")) return "Linux";
  if (ua.includes("Android")) return "Android";
  if (ua.includes("iPhone") || ua.includes("iPad")) return "iOS";
  return "Other";
}

// ─── Tracked Links ───

app.post("/api/vi/tracked-links", (req, res) => {
  const { siteId, originalUrl, lead, messageType } = req.body;
  if (!originalUrl || !lead) return res.status(400).json({ error: "originalUrl and lead are required" });

  const linkId = genId("tl");
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  const link = {
    linkId,
    siteId: siteId || null,
    originalUrl,
    trackedUrl: `${baseUrl}/t/${linkId}`,
    leadInfo: { name: lead.name, email: lead.email, company: lead.company, title: lead.title, linkedinUrl: lead.linkedinUrl },
    messageType: messageType || "email",
    createdAt: new Date().toISOString(),
    clicks: 0,
    lastClicked: null
  };
  trackedLinks.set(linkId, link);
  scheduleSave();
  res.json({ success: true, link });
});

app.get("/api/vi/tracked-links", (req, res) => {
  let links = [...trackedLinks.values()];
  if (req.query.siteId) links = links.filter(l => l.siteId === req.query.siteId);
  links.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ links });
});

// Tracked link redirect
app.get("/t/:linkId", (req, res) => {
  const link = trackedLinks.get(req.params.linkId);
  if (!link) return res.status(404).send("Link not found");

  link.clicks = (link.clicks || 0) + 1;
  link.lastClicked = new Date().toISOString();
  scheduleSave();

  // Append _bvt param to destination URL
  const url = new URL(link.originalUrl);
  url.searchParams.set("_bvt", link.linkId);
  res.redirect(302, url.toString());
});

// ─── Visitor Data Queries ───

app.get("/api/vi/visitors", (req, res) => {
  let list = [...visitors.values()];

  if (req.query.siteId) list = list.filter(v => v.siteIds && v.siteIds.includes(req.query.siteId));
  if (req.query.identified === "true") list = list.filter(v => v.identified);
  if (req.query.identified === "false") list = list.filter(v => !v.identified);

  const sort = req.query.sort || "lastSeen";
  list.sort((a, b) => {
    if (sort === "engagementScore") return (b.engagementScore || 0) - (a.engagementScore || 0);
    if (sort === "totalPageviews") return (b.totalPageviews || 0) - (a.totalPageviews || 0);
    return new Date(b.lastSeen) - new Date(a.lastSeen);
  });

  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 50;
  const total = list.length;
  list = list.slice(offset, offset + limit);

  res.json({ visitors: list, total });
});

app.get("/api/vi/visitors/:visitorId", (req, res) => {
  const visitor = visitors.get(req.params.visitorId);
  if (!visitor) return res.status(404).json({ error: "Visitor not found" });

  const timeline = eventBuffer
    .filter(e => e.visitorId === visitor.visitorId)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Group into sessions
  const sessionMap = {};
  timeline.forEach(e => {
    if (!sessionMap[e.sessionId]) sessionMap[e.sessionId] = { sessionId: e.sessionId, events: [], startTime: e.timestamp };
    sessionMap[e.sessionId].events.push(e);
    if (new Date(e.timestamp) < new Date(sessionMap[e.sessionId].startTime)) sessionMap[e.sessionId].startTime = e.timestamp;
  });

  res.json({ visitor, timeline: timeline.slice(0, 200), sessions: Object.values(sessionMap) });
});

app.get("/api/vi/live", (req, res) => {
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  const active = [];

  for (const [visitorId, session] of activeSessions) {
    if (session.timestamp < fiveMinAgo) { activeSessions.delete(visitorId); continue; }
    if (req.query.siteId && session.siteId !== req.query.siteId) continue;
    const visitor = visitors.get(visitorId);
    if (!visitor) continue;
    active.push({
      visitorId,
      currentPage: session.page,
      identified: visitor.identified,
      identity: visitor.identity,
      geo: visitor.geo,
      device: visitor.device,
      activeFor: Math.round((Date.now() - session.timestamp) / 1000)
    });
  }

  res.json({ activeVisitors: active, count: active.length });
});

// ─── Dashboard Aggregates ───

app.get("/api/vi/dashboard", (req, res) => {
  const siteId = req.query.siteId;
  const period = req.query.period || "all";

  let cutoff = 0;
  if (period === "today") cutoff = new Date().setHours(0, 0, 0, 0);
  else if (period === "7d") cutoff = Date.now() - 7 * 24 * 3600000;
  else if (period === "30d") cutoff = Date.now() - 30 * 24 * 3600000;

  let events = eventBuffer;
  if (siteId) events = events.filter(e => e.siteId === siteId);
  if (cutoff) events = events.filter(e => new Date(e.timestamp).getTime() >= cutoff);

  let allVisitors = [...visitors.values()];
  if (siteId) allVisitors = allVisitors.filter(v => v.siteIds && v.siteIds.includes(siteId));

  const pageviews = events.filter(e => e.type === "pageview");

  // Top pages
  const pageCounts = {};
  pageviews.forEach(e => {
    const p = e.data?.path || e.data?.url || "/";
    pageCounts[p] = (pageCounts[p] || 0) + 1;
  });
  const topPages = Object.entries(pageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, views]) => ({ path, views }));

  // Top referrers
  const refCounts = {};
  pageviews.forEach(e => {
    const ref = e.data?.referrer;
    if (ref) {
      try { const host = new URL(ref).hostname; if (host) refCounts[host] = (refCounts[host] || 0) + 1; } catch {}
    }
  });
  const topReferrers = Object.entries(refCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([referrer, count]) => ({ referrer, count }));

  // Visitors by day (last 30 days)
  const dayMap = {};
  pageviews.forEach(e => {
    const day = e.timestamp?.split("T")[0];
    if (day) {
      if (!dayMap[day]) dayMap[day] = new Set();
      dayMap[day].add(e.visitorId);
    }
  });
  const visitorsByDay = Object.entries(dayMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-30)
    .map(([date, set]) => ({ date, count: set.size }));

  // Live count
  const fiveMinAgo = Date.now() - 5 * 60 * 1000;
  let activeNow = 0;
  for (const [, session] of activeSessions) {
    if (session.timestamp >= fiveMinAgo && (!siteId || session.siteId === siteId)) activeNow++;
  }

  // Recent identified
  const identified = allVisitors
    .filter(v => v.identified)
    .sort((a, b) => new Date(b.identity?.identifiedAt || b.lastSeen) - new Date(a.identity?.identifiedAt || a.lastSeen))
    .slice(0, 10);

  // Recent visitors
  const recent = allVisitors
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen))
    .slice(0, 20);

  res.json({
    totalVisitors: allVisitors.length,
    identifiedVisitors: allVisitors.filter(v => v.identified).length,
    totalPageviews: pageviews.length,
    activeNow,
    topPages,
    topReferrers,
    visitorsByDay,
    identifiedRecently: identified,
    recentVisitors: recent
  });
});

// ─── SSE Stream ───

app.get("/api/vi/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });
  res.write("data: {\"type\":\"connected\"}\n\n");

  const clientId = Date.now() + Math.random();
  sseClients.set(clientId, res);
  req.on("close", () => sseClients.delete(clientId));
});

// ─── Export Visitors ───

app.post("/api/vi/export-visitors", (req, res) => {
  try {
    let list = [...visitors.values()];
    if (req.body.siteId) list = list.filter(v => v.siteIds && v.siteIds.includes(req.body.siteId));
    if (req.body.identified === true) list = list.filter(v => v.identified);

    if (!list.length) return res.status(400).json({ error: "No visitors to export" });

    const excelData = list.map(v => ({
      "Visitor ID": v.visitorId,
      "Identified": v.identified ? "Yes" : "No",
      "Name": v.identity?.name || "",
      "Email": v.identity?.email || "",
      "Company": v.identity?.company || v.company?.name || "",
      "Title": v.identity?.title || "",
      "City": v.geo?.city || "",
      "Country": v.geo?.country || "",
      "Organization (ISP)": v.geo?.org || "",
      "Browser": v.device?.browser || "",
      "OS": v.device?.os || "",
      "Device": v.device?.deviceType || "",
      "Total Sessions": v.totalSessions,
      "Total Pageviews": v.totalPageviews,
      "Engagement Score": v.engagementScore,
      "First Seen": v.firstSeen,
      "Last Seen": v.lastSeen,
      "Source": v.identity?.source || ""
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(excelData);
    ws["!cols"] = [
      { wch: 18 }, { wch: 10 }, { wch: 25 }, { wch: 30 }, { wch: 30 }, { wch: 30 },
      { wch: 15 }, { wch: 15 }, { wch: 30 }, { wch: 15 }, { wch: 15 }, { wch: 10 },
      { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 22 }, { wch: 22 }, { wch: 12 }
    ];
    XLSX.utils.book_append_sheet(wb, ws, "Visitors");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename=Belwo_Visitors_${new Date().toISOString().split("T")[0]}.xlsx`);
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: "Export failed: " + err.message });
  }
});

// ═══════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => {
  console.log(`Belwo Lead Generation Tool running on port ${PORT}`);
  console.log(`Using OpenRouter API — model: ${selectedModel}`);
  console.log(`Visitor Intelligence active — ${sites.size} sites, ${visitors.size} visitors tracked`);
});
