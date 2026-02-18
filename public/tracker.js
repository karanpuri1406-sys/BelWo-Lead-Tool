/**
 * Belwo Visitor Intelligence - Embeddable Tracking Script
 * Usage: <script src="http://your-server/tracker.js?sid=SITE_ID" async></script>
 */
(function() {
  'use strict';

  // Extract site ID and server URL from script tag
  var currentScript = document.currentScript;
  if (!currentScript) {
    // Fallback: find script by src containing tracker.js
    var scripts = document.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
      if (scripts[i].src && scripts[i].src.indexOf('tracker.js') !== -1) {
        currentScript = scripts[i];
        break;
      }
    }
  }
  if (!currentScript || !currentScript.src) return;

  var siteId, serverUrl;
  try {
    var u = new URL(currentScript.src);
    siteId = u.searchParams.get('sid');
    serverUrl = u.origin;
  } catch(e) { return; }

  if (!siteId) return;

  // Simple fingerprint (djb2 hash of browser properties)
  function fingerprint() {
    var parts = [
      navigator.userAgent,
      navigator.language,
      screen.width + 'x' + screen.height,
      screen.colorDepth,
      navigator.platform,
      new Date().getTimezoneOffset(),
      navigator.hardwareConcurrency || ''
    ];
    try { parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch(e) {}
    var str = parts.join('|');
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  // Session ID via sessionStorage
  var sessionId = null;
  try {
    sessionId = sessionStorage.getItem('_bvi_sid');
    if (!sessionId) {
      sessionId = 's_' + Math.random().toString(36).substr(2, 9);
      sessionStorage.setItem('_bvi_sid', sessionId);
    }
  } catch(e) {
    sessionId = 's_' + Math.random().toString(36).substr(2, 9);
  }

  // Extract UTM and tracking params
  function getParams() {
    try {
      var p = new URLSearchParams(window.location.search);
      return {
        utmSource: p.get('utm_source'),
        utmMedium: p.get('utm_medium'),
        utmCampaign: p.get('utm_campaign'),
        utmTerm: p.get('utm_term'),
        utmContent: p.get('utm_content'),
        trackingId: p.get('_bvt')
      };
    } catch(e) { return {}; }
  }

  // Send event
  function send(type, data) {
    var payload = JSON.stringify({
      siteId: siteId,
      fingerprint: fingerprint(),
      sessionId: sessionId,
      type: type,
      timestamp: new Date().toISOString(),
      data: Object.assign({
        url: window.location.href,
        path: window.location.pathname,
        title: document.title,
        referrer: document.referrer
      }, getParams(), data || {})
    });

    var url = serverUrl + '/api/track';
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([payload], {type: 'text/plain'}));
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(payload);
      }
    } catch(e) {}
  }

  // Device type
  var deviceType = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' :
                   /Tablet|iPad/i.test(navigator.userAgent) ? 'tablet' : 'desktop';

  // Track pageview
  var loadTime = Date.now();
  send('pageview', {
    screenWidth: screen.width,
    screenHeight: screen.height,
    deviceType: deviceType
  });

  // Track max scroll depth (throttled)
  var maxScroll = 0;
  var scrollTimer;
  window.addEventListener('scroll', function() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function() {
      var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
      var docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      var winHeight = window.innerHeight;
      if (docHeight > winHeight) {
        var depth = Math.round((scrollTop + winHeight) / docHeight * 100);
        if (depth > maxScroll) maxScroll = depth;
      }
    }, 250);
  });

  // Track exit (time on page + scroll depth)
  window.addEventListener('beforeunload', function() {
    send('exit', {
      timeOnPage: Date.now() - loadTime,
      scrollDepth: maxScroll
    });
  });

  // Track clicks on links
  document.addEventListener('click', function(e) {
    var link = e.target.closest ? e.target.closest('a') : null;
    if (link && link.href) {
      var isExternal = link.hostname !== window.location.hostname;
      var isHighIntent = /contact|pricing|demo|consultation|book|schedule|signup|register/i.test(link.href) ||
                         /contact|pricing|demo|consultation|book|schedule|signup|register/i.test(link.textContent);
      if (isExternal || isHighIntent) {
        send('click', {
          elementText: (link.textContent || '').trim().substring(0, 100),
          elementHref: link.href,
          isExternal: isExternal,
          isHighIntent: isHighIntent
        });
      }
    }
  });
})();
