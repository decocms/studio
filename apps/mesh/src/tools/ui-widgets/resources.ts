import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps";

const tokens = {
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  fontMono: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
  fontSize: "14px",
  borderRadius: "8px",
  shadow: "0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)",
  primary: "#6366f1",
  primaryLight: "#818cf8",
  success: "#22c55e",
  warning: "#f59e0b",
  danger: "#ef4444",
  gray100: "#f3f4f6",
  gray200: "#e5e7eb",
  gray300: "#d1d5db",
  gray500: "#6b7280",
  gray700: "#374151",
  gray900: "#111827",
};

const baseCSS = `
  :root { color-scheme: light only; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: ${tokens.fontFamily}; font-size: ${tokens.fontSize}; color: ${tokens.gray900}; background: transparent; padding: 0; line-height: 1.5; }
`;

function notifySize(): string {
  return `parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:document.body.scrollHeight}},'*');`;
}

function widgetScript(
  widgetName: string,
  applyBody: string,
  toolResultBody?: string,
): string {
  return `<script>
let requestId = 1;
function applyArguments(args) {
${applyBody}
  ${notifySize()}
}
window.addEventListener('message', function(e) {
  var msg = e.data;
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
  if (msg.id === 1 && msg.result) {
    parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}},'*');
  }
  if (msg.method === 'ui/notifications/tool-input') {
    applyArguments(msg.params && msg.params.arguments ? msg.params.arguments : {});
  }
  if (msg.method === 'ui/notifications/tool-result') {
    ${toolResultBody ?? ""}
  }
});
parent.postMessage({jsonrpc:'2.0',id:requestId++,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'${widgetName}',version:'1.0.0'},appCapabilities:{}}},'*');
</script>`;
}

interface UIWidgetResource {
  name: string;
  description: string;
  /** HTML content for legacy srcDoc-based widgets */
  html?: string;
  /** Route path for React-based widgets (e.g. "/_widgets/counter") */
  path?: string;
  exampleInput: Record<string, unknown>;
  /** If true, widget has its own visual container and should render without an outer border/padding wrapper */
  borderless?: boolean;
}

const UI_WIDGET_RESOURCES: Record<string, UIWidgetResource> = {
  // ─── React-based widgets (served via /_widgets/* routes) ───────────────────
  "/_widgets/area-chart": {
    name: "Area Chart",
    description: "Display an area chart with gradient fill",
    path: "/_widgets/area-chart",
    exampleInput: {
      data: [
        { label: "Jan", value: 10 },
        { label: "Feb", value: 25 },
        { label: "Mar", value: 18 },
        { label: "Apr", value: 35 },
      ],
      title: "Revenue",
    },
  },
  "/_widgets/calendar": {
    name: "Calendar",
    description: "Display a mini calendar with highlighted dates",
    path: "/_widgets/calendar",
    exampleInput: { month: 2, year: 2026, highlightedDates: [14, 20, 25] },
  },
  "/_widgets/chart": {
    name: "Chart",
    description: "Display an animated bar chart with labeled data points",
    path: "/_widgets/chart",
    exampleInput: {
      data: [
        { label: "Mon", value: 40 },
        { label: "Tue", value: 80 },
        { label: "Wed", value: 60 },
        { label: "Thu", value: 90 },
        { label: "Fri", value: 50 },
      ],
      title: "Weekly Stats",
    },
  },
  "/_widgets/code": {
    name: "Code",
    description: "Display a syntax-highlighted code snippet",
    path: "/_widgets/code",
    borderless: true,
    exampleInput: {
      code: "const greet = (name: string) => `Hello, ${name}!`;",
      language: "typescript",
    },
  },
  "/_widgets/counter": {
    name: "Counter",
    description: "Interactive counter widget with increment/decrement controls",
    path: "/_widgets/counter",
    exampleInput: { initialValue: 42, label: "My Counter" },
  },
  "/_widgets/sparkline": {
    name: "Sparkline",
    description: "Display a compact sparkline trend chart",
    path: "/_widgets/sparkline",
    exampleInput: {
      values: [10, 25, 15, 40, 30, 55, 45],
      label: "Revenue",
    },
  },
  "/_widgets/table": {
    name: "Table",
    description: "Display a data table with columns and rows",
    path: "/_widgets/table",
    exampleInput: {
      columns: ["Name", "Status", "Count"],
      rows: [
        ["Alice", "Active", "42"],
        ["Bob", "Pending", "17"],
        ["Carol", "Active", "98"],
      ],
      title: "Users",
    },
  },

  // ─── Legacy HTML-based widgets ─────────────────────────────────────────────
  "ui://mesh/counter": {
    name: "Counter",
    description: "Interactive counter widget with increment/decrement controls",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.counter { text-align: center; padding: 8px 0; }
.counter .label { font-size: 12px; color: ${tokens.gray700}; margin-bottom: 4px; }
.counter .value { font-size: 32px; font-weight: 700; color: ${tokens.primary}; margin: 4px 0 8px; }
.counter .controls { display: flex; gap: 6px; justify-content: center; }
.counter button { width: 34px; height: 34px; border-radius: ${tokens.borderRadius}; border: 1px solid ${tokens.gray200}; background: white; font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
.counter button:hover { background: ${tokens.primary}; color: white; border-color: ${tokens.primary}; }
</style></head><body>
<div class="counter">
  <div class="label" id="lbl">Counter</div>
  <div class="value" id="val">0</div>
  <div class="controls">
    <button onclick="update(-1)">&minus;</button>
    <button onclick="update(1)">+</button>
  </div>
</div>
${widgetScript(
  "Counter",
  `
  var v = typeof args.initialValue === 'number' ? args.initialValue : 0;
  document.getElementById('val').textContent = v;
  document.getElementById('val').dataset.value = v;
  if (args.label) document.getElementById('lbl').textContent = args.label;
`,
)}
<script>
function update(d) {
  var el = document.getElementById('val');
  var v = parseInt(el.dataset.value || '0', 10) + d;
  el.dataset.value = v;
  el.textContent = v;
}
</script>
</body></html>`,
    exampleInput: { initialValue: 42, label: "My Counter" },
  },

  "ui://mesh/metric": {
    name: "Metric",
    description: "Key metric display with value, unit, and trend indicator",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.metric { padding: 4px 0; }
.metric .label { font-size: 11px; color: ${tokens.gray700}; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 2px; }
.metric .row { display: flex; align-items: baseline; gap: 6px; }
.metric .prefix { font-size: 28px; font-weight: 600; color: ${tokens.gray700}; }
.metric .value { font-size: 36px; font-weight: 700; color: ${tokens.gray900}; }
.metric .suffix { font-size: 14px; font-weight: 500; color: ${tokens.gray700}; }
.metric .trend { font-size: 13px; font-weight: 600; margin-top: 4px; display: flex; align-items: center; gap: 4px; }
.metric .trend.up { color: ${tokens.success}; }
.metric .trend.down { color: ${tokens.danger}; }
</style></head><body>
<div class="metric">
  <div class="label" id="lbl">Metric</div>
  <div class="row"><span class="prefix" id="prefix"></span><span class="value" id="val">0</span><span class="suffix" id="suffix"></span></div>
  <div class="trend" id="trend"></div>
</div>
${widgetScript(
  "Metric",
  `
  if (args.label) document.getElementById('lbl').textContent = args.label;
  if (args.value !== undefined) document.getElementById('val').textContent = Number(args.value).toLocaleString();
  var u = args.unit || '';
  var isPrefix = u.length <= 1 || /^[$€£¥₹%#]$/.test(u);
  document.getElementById('prefix').textContent = isPrefix ? u : '';
  document.getElementById('suffix').textContent = isPrefix ? '' : u;
  var t = document.getElementById('trend');
  if (args.trend !== undefined) {
    var up = args.trend >= 0;
    t.className = 'trend ' + (up ? 'up' : 'down');
    t.textContent = (up ? '\\u25B2 +' : '\\u25BC ') + args.trend + '%';
  } else { t.textContent = ''; }
`,
)}
</body></html>`,
    exampleInput: { value: 1234, label: "Revenue", unit: "$", trend: 12.5 },
  },

  "ui://mesh/progress": {
    name: "Progress",
    description: "Progress bar with label and percentage",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.progress { padding: 4px 0; }
.progress .header { display: flex; justify-content: space-between; margin-bottom: 8px; }
.progress .label { font-size: 13px; font-weight: 500; }
.progress .pct { font-size: 13px; color: ${tokens.gray700}; }
.progress .track { height: 8px; background: ${tokens.gray100}; border-radius: 4px; overflow: hidden; }
.progress .fill { height: 100%; background: linear-gradient(90deg, ${tokens.primary}, ${tokens.primaryLight}); border-radius: 4px; transition: width 0.5s ease; }
</style></head><body>
<div class="progress">
  <div class="header"><span class="label" id="lbl">Progress</span><span class="pct" id="pct">0%</span></div>
  <div class="track"><div class="fill" id="fill" style="width:0%"></div></div>
</div>
${widgetScript(
  "Progress",
  `
  var v = args.value || 0, mx = args.max || 100;
  var pct = Math.min(100, Math.round((v / mx) * 100));
  document.getElementById('fill').style.width = pct + '%';
  document.getElementById('pct').textContent = pct + '%';
  if (args.label) document.getElementById('lbl').textContent = args.label;
`,
)}
</body></html>`,
    exampleInput: { value: 75, max: 100, label: "Upload Progress" },
  },

  "ui://mesh/greeting": {
    name: "Greeting",
    description: "Personalized greeting card",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.greeting { text-align: center; padding: 24px 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: ${tokens.borderRadius}; color: white; }
.greeting .wave { font-size: 36px; margin-bottom: 8px; }
.greeting .name { font-size: 22px; font-weight: 700; }
.greeting .msg { font-size: 14px; opacity: 0.9; margin-top: 6px; }
</style></head><body>
<div class="greeting">
  <div class="wave">&#128075;</div>
  <div class="name" id="name">Hello!</div>
  <div class="msg" id="msg">Welcome!</div>
</div>
${widgetScript(
  "Greeting",
  `
  document.getElementById('name').textContent = args.name ? 'Hello, ' + args.name + '!' : 'Hello!';
  document.getElementById('msg').textContent = args.message || 'Welcome!';
`,
)}
</body></html>`,
    exampleInput: { name: "Alice", message: "Welcome back!" },
  },

  "ui://mesh/chart": {
    name: "Chart",
    description: "Bar chart for visualizing categorical data",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.chart { padding: 4px 0; }
.chart .title { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
.chart .bars { display: flex; align-items: flex-end; gap: 8px; height: 120px; padding-top: 8px; }
.chart .bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
.chart .bar { width: 100%; min-width: 20px; background: linear-gradient(180deg, ${tokens.primaryLight}, ${tokens.primary}); border-radius: 4px 4px 0 0; transition: height 0.4s ease; }
.chart .bar-label { font-size: 11px; color: ${tokens.gray700}; margin-top: 6px; text-align: center; }
.chart .bar-value { font-size: 11px; font-weight: 600; margin-bottom: 4px; }
</style></head><body>
<div class="chart">
  <div class="title" id="title">Chart</div>
  <div class="bars" id="bars"></div>
</div>
${widgetScript(
  "Chart",
  `
  if (args.title) document.getElementById('title').textContent = args.title;
  var c = document.getElementById('bars');
  c.innerHTML = '';
  var data = args.data || [];
  var mx = Math.max.apply(null, data.map(function(d){return d.value||0})) || 1;
  data.forEach(function(d) {
    var w = document.createElement('div'); w.className = 'bar-wrap';
    var v = document.createElement('div'); v.className = 'bar-value'; v.textContent = d.value;
    var b = document.createElement('div'); b.className = 'bar';
    b.style.height = Math.max(4, ((d.value||0)/mx)*100) + '%';
    var l = document.createElement('div'); l.className = 'bar-label'; l.textContent = d.label||'';
    w.appendChild(v); w.appendChild(b); w.appendChild(l); c.appendChild(w);
  });
`,
)}
</body></html>`,
    exampleInput: {
      data: [
        { label: "Jan", value: 10 },
        { label: "Feb", value: 25 },
        { label: "Mar", value: 15 },
      ],
      title: "Monthly Sales",
    },
  },

  "ui://mesh/timer": {
    name: "Timer",
    description: "Countdown timer with start, pause, and reset controls",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.timer { text-align: center; padding: 4px 0; }
.timer .label { font-size: 12px; color: ${tokens.gray700}; margin-bottom: 4px; }
.timer .display { font-size: 28px; font-weight: 600; font-family: ${tokens.fontMono}; letter-spacing: 1px; margin: 4px 0 12px; color: ${tokens.gray900}; }
.timer .controls { display: flex; gap: 6px; justify-content: center; }
.timer button { padding: 5px 14px; border-radius: 6px; border: 1px solid ${tokens.gray200}; font-size: 12px; font-weight: 500; cursor: pointer; background: white; color: ${tokens.gray700}; transition: all 0.15s; }
.timer button:hover { background: ${tokens.gray100}; border-color: ${tokens.gray300}; }
.timer .start { color: ${tokens.success}; border-color: ${tokens.success}; }
.timer .start:hover { background: #f0fdf4; }
.timer .pause { color: ${tokens.warning}; border-color: ${tokens.warning}; }
.timer .pause:hover { background: #fffbeb; }
</style></head><body>
<div class="timer">
  <div class="label" id="lbl">Timer</div>
  <div class="display" id="display">00:00</div>
  <div class="controls">
    <button class="start" onclick="startTimer()">Start</button>
    <button class="pause" onclick="pauseTimer()">Pause</button>
    <button class="reset" onclick="resetTimer()">Reset</button>
  </div>
</div>
${widgetScript(
  "Timer",
  `
  window._timerDuration = (args.duration ?? 60);
  window._remaining = window._timerDuration;
  if (args.label) document.getElementById('lbl').textContent = args.label;
  renderTime();
`,
)}
<script>
window._remaining = 60; window._timerDuration = 60; window._interval = null;
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function renderTime() {
  var m = Math.floor(window._remaining / 60), s = window._remaining % 60;
  document.getElementById('display').textContent = pad(m) + ':' + pad(s);
}
function startTimer() {
  if (window._interval) return;
  window._interval = setInterval(function() {
    if (window._remaining <= 0) { pauseTimer(); return; }
    window._remaining--; renderTime();
  }, 1000);
}
function pauseTimer() { clearInterval(window._interval); window._interval = null; }
function resetTimer() { pauseTimer(); window._remaining = window._timerDuration; renderTime(); }
</script>
</body></html>`,
    exampleInput: { duration: 120, label: "Break Timer" },
  },

  "ui://mesh/status": {
    name: "Status",
    description: "Status badge with colored indicator",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.status { display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 20px; background: ${tokens.gray100}; }
.status .dot { width: 10px; height: 10px; border-radius: 50%; }
.status .dot.online { background: ${tokens.success}; box-shadow: 0 0 6px ${tokens.success}; }
.status .dot.offline { background: ${tokens.gray300}; }
.status .dot.error { background: ${tokens.danger}; box-shadow: 0 0 6px ${tokens.danger}; }
.status .dot.warning { background: ${tokens.warning}; box-shadow: 0 0 6px ${tokens.warning}; }
.status .text { font-size: 13px; font-weight: 500; }
</style></head><body>
<div class="status">
  <div class="dot" id="dot"></div>
  <span class="text" id="text">Status</span>
</div>
${widgetScript(
  "Status",
  `
  var s = (args.status || 'offline').toLowerCase();
  var dotClass = 'dot';
  if (s === 'online' || s === 'ok' || s === 'up') dotClass += ' online';
  else if (s === 'error' || s === 'down') dotClass += ' error';
  else if (s === 'warning' || s === 'degraded') dotClass += ' warning';
  else dotClass += ' offline';
  document.getElementById('dot').className = dotClass;
  document.getElementById('text').textContent = args.label || (s.charAt(0).toUpperCase() + s.slice(1));
`,
)}
</body></html>`,
    exampleInput: { status: "online", label: "Server Status" },
  },

  "ui://mesh/quote": {
    name: "Quote",
    description: "Quote display with author attribution",
    borderless: true,
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.quote { padding: 16px 20px; border-left: 3px solid ${tokens.primary}; background: ${tokens.gray100}; border-radius: 0 ${tokens.borderRadius} ${tokens.borderRadius} 0; }
.quote .text { font-size: 16px; font-style: italic; line-height: 1.6; color: ${tokens.gray900}; }
.quote .author { font-size: 13px; color: ${tokens.gray700}; margin-top: 10px; font-weight: 500; }
.quote .author::before { content: '\\2014\\00A0'; }
</style></head><body>
<div class="quote">
  <div class="text" id="text"></div>
  <div class="author" id="author"></div>
</div>
${widgetScript(
  "Quote",
  `
  document.getElementById('text').textContent = args.text || '';
  document.getElementById('author').textContent = args.author || '';
  document.getElementById('author').style.display = args.author ? 'block' : 'none';
`,
)}
</body></html>`,
    exampleInput: {
      text: "The only way to do great work is to love what you do.",
      author: "Steve Jobs",
    },
  },

  "ui://mesh/sparkline": {
    name: "Sparkline",
    description: "Compact sparkline chart for trend visualization",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.sparkline { padding: 4px 0; }
.sparkline .label { font-size: 14px; font-weight: 600; color: ${tokens.gray900}; margin-bottom: 12px; }
.sparkline svg { display: block; width: 100%; height: 48px; }
</style></head><body>
<div class="sparkline">
  <div class="label" id="lbl">Trend</div>
  <svg id="svg"></svg>
</div>
${widgetScript(
  "Sparkline",
  `
  if (args.label) document.getElementById('lbl').textContent = args.label;
  var vals = args.values || [];
  if (!vals.length) return;
  var svg = document.getElementById('svg');
  var W = svg.clientWidth || svg.getBoundingClientRect().width || 300;
  var H = 48;
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
  var range = mx - mn || 1;
  var pad = 2;
  var step = (W - pad * 2) / (vals.length - 1 || 1);
  var pts = vals.map(function(v, i) {
    return (pad + i * step).toFixed(1) + ',' + (H - pad - ((v - mn) / range) * (H - pad * 2)).toFixed(1);
  });
  var areaPath = 'M' + pad + ',' + H + ' L' + pts.join(' L') + ' L' + (pad + (vals.length-1)*step).toFixed(1) + ',' + H + ' Z';
  var linePath = 'M' + pts.join(' L');
  svg.innerHTML = '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${tokens.primary}" stop-opacity="0.2"/><stop offset="100%" stop-color="${tokens.primary}" stop-opacity="0"/></linearGradient></defs><path d="' + areaPath + '" fill="url(#g)"/><path d="' + linePath + '" fill="none" stroke="${tokens.primary}" stroke-width="1.5"/>';
`,
)}
</body></html>`,
    exampleInput: {
      values: [10, 25, 15, 30, 20, 35, 28],
      label: "Weekly Trend",
    },
  },

  "ui://mesh/code": {
    name: "Code",
    description: "Code snippet display with language label",
    borderless: true,
    html:
      `<!DOCTYPE html><html><head><style>${baseCSS}
.code-block { background: ${tokens.gray100}; border-radius: ${tokens.borderRadius}; overflow: hidden; }
.code-block .header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid ${tokens.gray200}; }
.code-block .lang { font-size: 11px; color: ${tokens.gray700}; text-transform: uppercase; letter-spacing: 0.05em; }
.code-block .copy { font-size: 11px; color: ${tokens.gray700}; background: none; border: 1px solid ${tokens.gray300}; border-radius: 4px; padding: 2px 8px; cursor: pointer; }
.code-block .copy:hover { background: ${tokens.gray200}; }
.code-block pre { padding: 12px 16px; overflow-x: auto; margin: 0; }
.code-block code { font-family: ${tokens.fontMono}; font-size: 13px; color: ${tokens.gray900}; line-height: 1.6; white-space: pre; }
.code-block .kw { color: #8250df; }
.code-block .str { color: #0a3069; }
.code-block .num { color: #0550ae; }
.code-block .cm { color: #6e7781; font-style: italic; }
.code-block .fn { color: #8250df; }
.code-block .op { color: #cf222e; }
</style></head><body>
<div class="code-block">
  <div class="header"><span class="lang" id="lang">code</span><button class="copy" onclick="copyCode()">Copy</button></div>
  <pre><code id="code"></code></pre>
</div>
${widgetScript(
  "Code",
  `
  var el = document.getElementById('code');
  var code = args.code || '';
  document.getElementById('lang').textContent = args.language || 'text';
  el.innerHTML = highlightCode(code);
`,
)}
<scr` +
      `ipt>
function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function highlightCode(code) {
  var S = function(c,t){return '<' + 'span class="' + c + '">' + t + '<' + '/span>';};
  return escH(code).split('\\n').map(function(line) {
    var trimmed = line.replace(/^\\s+/, '');
    if (trimmed.indexOf('//') === 0) return S('cm', line);
    line = line.replace(/\\b(const|let|var|function|return|if|else|for|while|import|export|from|async|await|new|class|extends|default|try|catch|throw|typeof|instanceof)\\b/g, function(m){return S('kw',m);});
    line = line.replace(/(&quot;[^&]*?&quot;)/g, function(m){return S('str',m);});
    line = line.replace(/(&#39;[^&]*?&#39;)/g, function(m){return S('str',m);});
    line = line.replace(/(\\b\\d+\\.?\\d*\\b)/g, function(m){return S('num',m);});
    var ci = line.indexOf('//');
    if (ci > -1) { line = line.substring(0, ci) + S('cm', line.substring(ci)); }
    return line;
  }).join('\\n');
}
function copyCode() {
  var t = document.getElementById('code').textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(t);
}
</scr` +
      `ipt>
</body></html>`,
    exampleInput: {
      code: "console.log('Hello, World!');",
      language: "javascript",
    },
  },

  "ui://mesh/confirmation": {
    name: "Confirmation",
    description: "Confirmation dialog with confirm and cancel actions",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.confirm { padding: 8px 0; }
.confirm .title { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
.confirm .msg { font-size: 14px; color: ${tokens.gray700}; margin-bottom: 16px; line-height: 1.5; }
.confirm .actions { display: flex; gap: 8px; justify-content: flex-end; }
.confirm button { padding: 8px 16px; border-radius: 6px; border: none; font-size: 13px; font-weight: 500; cursor: pointer; }
.confirm .cancel { background: ${tokens.gray200}; color: ${tokens.gray700}; }
.confirm .ok { background: ${tokens.danger}; color: white; }
.confirm .ok:hover { opacity: 0.9; }
.confirm .result { margin-top: 12px; padding: 8px 12px; border-radius: 6px; font-size: 13px; display: none; }
.confirm .result.confirmed { background: #dcfce7; color: #166534; display: block; }
.confirm .result.cancelled { background: #fee2e2; color: #991b1b; display: block; }
</style></head><body>
<div class="confirm">
  <div class="title" id="title">Confirm?</div>
  <div class="msg" id="msg"></div>
  <div class="actions">
    <button class="cancel" id="cancelBtn" onclick="choose(false)">Cancel</button>
    <button class="ok" id="okBtn" onclick="choose(true)">Confirm</button>
  </div>
  <div class="result" id="result"></div>
</div>
${widgetScript(
  "Confirmation",
  `
  document.getElementById('title').textContent = args.title || 'Confirm?';
  document.getElementById('msg').textContent = args.message || '';
  document.getElementById('okBtn').textContent = args.confirmLabel || 'Confirm';
  document.getElementById('cancelBtn').textContent = args.cancelLabel || 'Cancel';
  document.getElementById('result').className = 'result';
`,
)}
<script>
function choose(yes) {
  var r = document.getElementById('result');
  r.className = 'result ' + (yes ? 'confirmed' : 'cancelled');
  r.textContent = yes ? 'Confirmed' : 'Cancelled';
}
</script>
</body></html>`,
    exampleInput: {
      title: "Delete Item?",
      message: "This action cannot be undone.",
      confirmLabel: "Delete",
      cancelLabel: "Keep",
    },
  },

  "ui://mesh/json-viewer": {
    name: "JSON Viewer",
    description: "Interactive JSON tree viewer",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.json-viewer { padding: 4px 0; }
.json-viewer .title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.json-viewer .tree { font-family: ${tokens.fontMono}; font-size: 13px; line-height: 1.6; }
.json-viewer .key { color: #6366f1; }
.json-viewer .str { color: #22c55e; }
.json-viewer .num { color: #f59e0b; }
.json-viewer .bool { color: #ef4444; }
.json-viewer .null { color: ${tokens.gray700}; }
.json-viewer .bracket { color: ${tokens.gray700}; }
.json-viewer .toggle { cursor: pointer; user-select: none; }
.json-viewer .nested { padding-left: 20px; }
</style></head><body>
<div class="json-viewer">
  <div class="title" id="title">JSON</div>
  <div class="tree" id="tree"></div>
</div>
${widgetScript(
  "JSON Viewer",
  `
  if (args.title) document.getElementById('title').textContent = args.title;
  document.getElementById('tree').innerHTML = renderJSON(args.data);
`,
)}
<script>
function renderJSON(val, depth) {
  depth = depth || 0;
  if (val === null) return '<span class="null">null</span>';
  if (typeof val === 'boolean') return '<span class="bool">' + val + '</span>';
  if (typeof val === 'number') return '<span class="num">' + val + '</span>';
  if (typeof val === 'string') return '<span class="str">"' + escapeHTML(val) + '"</span>';
  if (Array.isArray(val)) {
    if (!val.length) return '<span class="bracket">[]</span>';
    var items = val.map(function(v, i) { return '<div class="nested">' + renderJSON(v, depth+1) + (i < val.length-1 ? ',' : '') + '</div>'; }).join('');
    return '<span class="bracket">[</span>' + items + '<span class="bracket">]</span>';
  }
  if (typeof val === 'object') {
    var keys = Object.keys(val);
    if (!keys.length) return '<span class="bracket">{}</span>';
    var entries = keys.map(function(k, i) {
      return '<div class="nested"><span class="key">"' + escapeHTML(k) + '"</span>: ' + renderJSON(val[k], depth+1) + (i < keys.length-1 ? ',' : '') + '</div>';
    }).join('');
    return '<span class="bracket">{</span>' + entries + '<span class="bracket">}</span>';
  }
  return String(val);
}
function escapeHTML(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
</script>
</body></html>`,
    exampleInput: {
      data: { name: "Alice", age: 30, tags: ["admin", "user"] },
      title: "User Data",
    },
  },

  "ui://mesh/table": {
    name: "Table",
    description: "Data table with header and rows",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.tbl { padding: 4px 0; }
.tbl .title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.tbl table { width: 100%; border-collapse: collapse; font-size: 13px; }
.tbl th { text-align: left; padding: 8px 12px; background: ${tokens.gray100}; font-weight: 600; border-bottom: 2px solid ${tokens.gray200}; }
.tbl td { padding: 8px 12px; border-bottom: 1px solid ${tokens.gray100}; }
.tbl tr:hover td { background: #f8f9ff; }
</style></head><body>
<div class="tbl">
  <div class="title" id="title">Table</div>
  <table id="table"></table>
</div>
${widgetScript(
  "Table",
  `
  if (args.title) document.getElementById('title').textContent = args.title;
  var t = document.getElementById('table');
  var html = '';
  if (args.columns) {
    html += '<thead><tr>' + args.columns.map(function(c){return '<th>'+escH(c)+'</th>';}).join('') + '</tr></thead>';
  }
  if (args.rows) {
    html += '<tbody>' + args.rows.map(function(r){return '<tr>'+r.map(function(c){return '<td>'+escH(String(c))+'</td>';}).join('')+'</tr>';}).join('') + '</tbody>';
  }
  t.innerHTML = html;
`,
)}
<script>function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}</script>
</body></html>`,
    exampleInput: {
      columns: ["Name", "Age", "Role"],
      rows: [
        ["Alice", "30", "Admin"],
        ["Bob", "25", "User"],
      ],
      title: "Team Members",
    },
  },

  "ui://mesh/diff": {
    name: "Diff",
    description: "Text diff view showing before and after changes",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.diff { padding: 4px 0; }
.diff .title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.diff .panes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.diff .pane { border-radius: 6px; overflow: hidden; }
.diff .pane-header { font-size: 11px; font-weight: 600; padding: 6px 10px; text-transform: uppercase; letter-spacing: 0.05em; }
.diff .before .pane-header { background: #fee2e2; color: #991b1b; }
.diff .after .pane-header { background: #dcfce7; color: #166534; }
.diff .pane-body { padding: 10px; font-family: ${tokens.fontMono}; font-size: 13px; white-space: pre-wrap; word-break: break-all; min-height: 40px; border: 1px solid ${tokens.gray200}; border-top: none; border-radius: 0 0 6px 6px; }
.diff .before .pane-body { background: #fef2f2; color: #991b1b; }
.diff .after .pane-body { background: #f0fdf4; color: #166534; }
</style></head><body>
<div class="diff">
  <div class="title" id="title">Diff</div>
  <div class="panes">
    <div class="pane before"><div class="pane-header">Before</div><div class="pane-body" id="before"></div></div>
    <div class="pane after"><div class="pane-header">After</div><div class="pane-body" id="after"></div></div>
  </div>
</div>
${widgetScript(
  "Diff",
  `
  if (args.title) document.getElementById('title').textContent = args.title;
  document.getElementById('before').textContent = args.before || '';
  document.getElementById('after').textContent = args.after || '';
`,
)}
</body></html>`,
    exampleInput: {
      before: "Hello World",
      after: "Hello Mesh",
      title: "Changes",
    },
  },

  "ui://mesh/todo": {
    name: "Todo",
    description: "Interactive todo list with checkboxes",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.todo { padding: 4px 0; }
.todo .title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.todo .items { list-style: none; }
.todo .item { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid ${tokens.gray100}; }
.todo .item:last-child { border-bottom: none; }
.todo .item input[type="checkbox"] { width: 18px; height: 18px; accent-color: ${tokens.primary}; cursor: pointer; }
.todo .item .text { font-size: 14px; }
.todo .item .text.done { text-decoration: line-through; color: ${tokens.gray700}; }
</style></head><body>
<div class="todo">
  <div class="title" id="title">Tasks</div>
  <ul class="items" id="items"></ul>
</div>
${widgetScript(
  "Todo",
  `
  if (args.title) document.getElementById('title').textContent = args.title;
  var ul = document.getElementById('items');
  ul.innerHTML = '';
  (args.items || []).forEach(function(item, i) {
    var li = document.createElement('li'); li.className = 'item';
    var cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!item.completed;
    var sp = document.createElement('span'); sp.className = 'text' + (item.completed ? ' done' : '');
    sp.textContent = item.text || '';
    cb.addEventListener('change', function() { sp.className = 'text' + (cb.checked ? ' done' : ''); });
    li.appendChild(cb); li.appendChild(sp); ul.appendChild(li);
  });
`,
)}
</body></html>`,
    exampleInput: {
      items: [
        { text: "Buy groceries", completed: true },
        { text: "Write code", completed: false },
      ],
      title: "Tasks",
    },
  },

  "ui://mesh/markdown": {
    name: "Markdown",
    description: "Simple markdown content renderer",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.md { padding: 4px 0; }
.md .title-bar { font-size: 12px; color: ${tokens.gray700}; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid ${tokens.gray100}; }
.md .content h1 { font-size: 24px; font-weight: 700; margin: 16px 0 8px; }
.md .content h2 { font-size: 20px; font-weight: 600; margin: 14px 0 6px; }
.md .content h3 { font-size: 16px; font-weight: 600; margin: 12px 0 4px; }
.md .content p { margin: 8px 0; line-height: 1.6; }
.md .content strong { font-weight: 600; }
.md .content em { font-style: italic; }
.md .content code { font-family: ${tokens.fontMono}; background: ${tokens.gray100}; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
.md .content pre { background: #0d1117; color: #c9d1d9; padding: 12px 16px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
.md .content pre code { background: none; padding: 0; color: inherit; font-size: 13px; line-height: 1.6; }
.md .content ul, .md .content ol { padding-left: 24px; margin: 8px 0; }
.md .content li { margin: 4px 0; }
.md .content blockquote { border-left: 3px solid ${tokens.primary}; padding-left: 12px; color: ${tokens.gray700}; margin: 8px 0; }
</style></head><body>
<div class="md">
  <div class="title-bar" id="titlebar"></div>
  <div class="content" id="content"></div>
</div>
${widgetScript(
  "Markdown",
  `
  document.getElementById('titlebar').textContent = args.title || 'Markdown';
  document.getElementById('titlebar').style.display = args.title ? 'block' : 'none';
  document.getElementById('content').innerHTML = renderMd(args.content || '');
`,
)}
<script>
function renderMd(md) {
  // Handle fenced code blocks first
  md = md.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g, function(m, lang, code) {
    return '<pre><code>' + code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</code></pre>';
  });
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^> (.+)$/gm, '<blockquote><p>$1</p></blockquote>')
    .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\\/li>)/s, '<ul>$1</ul>')
    .replace(/\\n{2,}/g, '</p><p>')
    .replace(/^(?!<[hbulop])(.+)$/gm, '<p>$1</p>');
}
</script>
</body></html>`,
    exampleInput: {
      content: "# Hello\n\nThis is **bold** and *italic*.",
      title: "README",
    },
  },

  "ui://mesh/image": {
    name: "Image",
    description: "Image display with optional caption",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.img-widget { text-align: center; }
.img-widget img { max-width: 100%; border-radius: ${tokens.borderRadius}; box-shadow: ${tokens.shadow}; }
.img-widget .caption { font-size: 12px; color: ${tokens.gray700}; margin-top: 8px; }
.img-widget .alt { font-size: 13px; color: ${tokens.gray700}; padding: 24px; border: 2px dashed ${tokens.gray200}; border-radius: ${tokens.borderRadius}; }
</style></head><body>
<div class="img-widget">
  <div id="container"></div>
  <div class="caption" id="caption"></div>
</div>
${widgetScript(
  "Image",
  `
  var c = document.getElementById('container');
  if (args.src) {
    var img = document.createElement('img');
    img.src = args.src;
    img.alt = args.alt || '';
    img.onload = function() { parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{height:document.body.scrollHeight}},'*'); };
    c.innerHTML = '';
    c.appendChild(img);
  } else {
    c.innerHTML = '<div class="alt">' + (args.alt || 'No image') + '</div>';
  }
  var cap = document.getElementById('caption');
  cap.textContent = args.caption || '';
  cap.style.display = args.caption ? 'block' : 'none';
`,
)}
</body></html>`,
    exampleInput: {
      src: "https://www.decocms.com/logo.svg",
      alt: "Deco Logo",
      caption: "Sample Image",
    },
  },

  "ui://mesh/form-result": {
    name: "Form Result",
    description: "Display form submission results with field values",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.form-result { padding: 4px 0; }
.form-result .header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.form-result .header .icon { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 14px; }
.form-result .header .icon.ok { background: #dcfce7; color: #166534; }
.form-result .header .icon.fail { background: #fee2e2; color: #991b1b; }
.form-result .header .title { font-size: 15px; font-weight: 600; color: ${tokens.gray900}; }
.form-result .fields { display: flex; flex-direction: column; gap: 8px; }
.form-result .field { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; background: ${tokens.gray100}; border-radius: 6px; }
.form-result .field .label { font-size: 11px; color: ${tokens.gray700}; text-transform: uppercase; letter-spacing: 0.05em; }
.form-result .field .value { font-size: 14px; font-weight: 500; }
</style></head><body>
<div class="form-result">
  <div class="header"><div class="icon" id="icon"></div><div class="title" id="title">Result</div></div>
  <div class="fields" id="fields"></div>
</div>
${widgetScript(
  "Form Result",
  `
  var ok = args.success !== false;
  var icon = document.getElementById('icon');
  icon.className = 'icon ' + (ok ? 'ok' : 'fail');
  icon.textContent = ok ? '\\u2713' : '\\u2717';
  document.getElementById('title').textContent = args.title || 'Form Result';
  var f = document.getElementById('fields');
  f.innerHTML = '';
  (args.fields || []).forEach(function(fld) {
    var d = document.createElement('div'); d.className = 'field';
    d.innerHTML = '<div class="label">' + escH(fld.label || '') + '</div><div class="value">' + escH(String(fld.value || '')) + '</div>';
    f.appendChild(d);
  });
`,
)}
<script>function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}</script>
</body></html>`,
    exampleInput: {
      fields: [
        { label: "Name", value: "Alice" },
        { label: "Email", value: "alice@example.com" },
      ],
      title: "Registration",
      success: true,
    },
  },

  "ui://mesh/error": {
    name: "Error",
    description: "Error message display with code and details",
    borderless: true,
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.error-widget { padding: 12px 16px; border-radius: ${tokens.borderRadius}; border: 1px solid #fca5a5; background: #fef2f2; }
.error-widget .header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.error-widget .icon { color: ${tokens.danger}; font-size: 18px; }
.error-widget .msg { font-size: 15px; font-weight: 600; color: #991b1b; }
.error-widget .code { font-size: 11px; font-family: ${tokens.fontMono}; color: #b91c1c; background: #fee2e2; padding: 2px 8px; border-radius: 4px; margin-top: 4px; display: inline-block; }
.error-widget .details { font-size: 13px; color: #7f1d1d; margin-top: 8px; line-height: 1.5; }
</style></head><body>
<div class="error-widget">
  <div class="header"><span class="icon">&#9888;</span><span class="msg" id="msg">Error</span></div>
  <div class="code" id="code"></div>
  <div class="details" id="details"></div>
</div>
${widgetScript(
  "Error",
  `
  document.getElementById('msg').textContent = args.message || 'An error occurred';
  var codeEl = document.getElementById('code');
  codeEl.textContent = args.code || '';
  codeEl.style.display = args.code ? 'inline-block' : 'none';
  var detEl = document.getElementById('details');
  detEl.textContent = args.details || '';
  detEl.style.display = args.details ? 'block' : 'none';
`,
)}
</body></html>`,
    exampleInput: {
      message: "Something went wrong",
      code: "ERR_404",
      details: "The requested resource was not found",
    },
  },

  "ui://mesh/notification": {
    name: "Notification",
    description: "Notification banner with type styling",
    borderless: true,
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.notif { padding: 12px 16px; border-radius: ${tokens.borderRadius}; display: flex; align-items: flex-start; gap: 10px; }
.notif.success { background: #f0fdf4; border: 1px solid #bbf7d0; }
.notif.error { background: #fef2f2; border: 1px solid #fecaca; }
.notif.warning { background: #fffbeb; border: 1px solid #fde68a; }
.notif.info { background: #eff6ff; border: 1px solid #bfdbfe; }
.notif .icon { font-size: 18px; flex-shrink: 0; margin-top: 1px; }
.notif .body .title { font-size: 14px; font-weight: 600; }
.notif .body .msg { font-size: 13px; margin-top: 2px; opacity: 0.85; }
.notif.success .body .title { color: #166534; }
.notif.error .body .title { color: #991b1b; }
.notif.warning .body .title { color: #92400e; }
.notif.info .body .title { color: #1e40af; }
</style></head><body>
<div class="notif info" id="notif">
  <span class="icon" id="icon">&#8505;</span>
  <div class="body"><div class="title" id="title">Notification</div><div class="msg" id="msg"></div></div>
</div>
${widgetScript(
  "Notification",
  `
  var type = (args.type || 'info').toLowerCase();
  var icons = { success: '\\u2713', error: '\\u2717', warning: '\\u26A0', info: '\\u2139' };
  document.getElementById('notif').className = 'notif ' + type;
  document.getElementById('icon').textContent = icons[type] || icons.info;
  document.getElementById('title').textContent = args.title || type.charAt(0).toUpperCase() + type.slice(1);
  document.getElementById('msg').textContent = args.message || '';
`,
)}
</body></html>`,
    exampleInput: {
      message: "Changes saved successfully",
      type: "success",
      title: "Success",
    },
  },

  "ui://mesh/avatar": {
    name: "Avatar",
    description: "Avatar display with name and online status",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.avatar-widget { display: flex; align-items: center; gap: 12px; }
.avatar-widget .circle { position: relative; width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 600; color: white; flex-shrink: 0; }
.avatar-widget .circle img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
.avatar-widget .status-dot { position: absolute; bottom: 1px; right: 1px; width: 12px; height: 12px; border-radius: 50%; border: 2px solid white; }
.avatar-widget .status-dot.online { background: ${tokens.success}; }
.avatar-widget .status-dot.offline { background: ${tokens.gray300}; }
.avatar-widget .status-dot.busy { background: ${tokens.danger}; }
.avatar-widget .info .name { font-size: 15px; font-weight: 600; }
.avatar-widget .info .status-text { font-size: 12px; color: ${tokens.gray700}; }
</style></head><body>
<div class="avatar-widget">
  <div class="circle" id="circle"><div class="status-dot" id="statusDot"></div></div>
  <div class="info"><div class="name" id="name"></div><div class="status-text" id="statusText"></div></div>
</div>
${widgetScript(
  "Avatar",
  `
  var name = args.name || 'User';
  document.getElementById('name').textContent = name;
  var circle = document.getElementById('circle');
  if (args.imageUrl) {
    circle.innerHTML = '<img src="' + args.imageUrl.replace(/"/g,'&quot;') + '" alt=""><div class="status-dot" id="statusDot"></div>';
  } else {
    var initials = name.split(' ').map(function(w){return w[0];}).join('').substring(0,2).toUpperCase();
    var colors = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#22c55e','#06b6d4'];
    var ci = 0; for(var i=0;i<name.length;i++) ci += name.charCodeAt(i);
    circle.style.background = colors[ci % colors.length];
    circle.innerHTML = initials + '<div class="status-dot" id="statusDot"></div>';
  }
  var s = (args.status || 'offline').toLowerCase();
  var dot = document.getElementById('statusDot');
  dot.className = 'status-dot ' + (s === 'online' ? 'online' : s === 'busy' ? 'busy' : 'offline');
  document.getElementById('statusText').textContent = s.charAt(0).toUpperCase() + s.slice(1);
`,
)}
</body></html>`,
    exampleInput: { name: "Alice Johnson", imageUrl: "", status: "online" },
  },

  "ui://mesh/switch": {
    name: "Switch",
    description: "Toggle switch with label and description",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.switch-widget { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; }
.switch-widget .text .label { font-size: 14px; font-weight: 500; }
.switch-widget .text .desc { font-size: 12px; color: ${tokens.gray700}; margin-top: 2px; }
.switch-widget .toggle { width: 44px; height: 24px; border-radius: 12px; background: ${tokens.gray300}; position: relative; cursor: pointer; transition: background 0.2s; flex-shrink: 0; }
.switch-widget .toggle.on { background: ${tokens.primary}; }
.switch-widget .toggle .knob { width: 20px; height: 20px; border-radius: 50%; background: white; position: absolute; top: 2px; left: 2px; transition: transform 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
.switch-widget .toggle.on .knob { transform: translateX(20px); }
</style></head><body>
<div class="switch-widget">
  <div class="text"><div class="label" id="lbl">Toggle</div><div class="desc" id="desc"></div></div>
  <div class="toggle" id="toggle" onclick="toggle()"><div class="knob"></div></div>
</div>
${widgetScript(
  "Switch",
  `
  document.getElementById('lbl').textContent = args.label || 'Toggle';
  var desc = document.getElementById('desc');
  desc.textContent = args.description || '';
  desc.style.display = args.description ? 'block' : 'none';
  var t = document.getElementById('toggle');
  t.className = 'toggle' + (args.checked ? ' on' : '');
`,
)}
<script>
function toggle() {
  var t = document.getElementById('toggle');
  t.classList.toggle('on');
}
</script>
</body></html>`,
    exampleInput: {
      label: "Dark Mode",
      checked: true,
      description: "Enable dark mode",
    },
  },

  "ui://mesh/slider": {
    name: "Slider",
    description: "Range slider with current value display",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.slider-widget { padding: 4px 0; }
.slider-widget .header { display: flex; justify-content: space-between; margin-bottom: 8px; }
.slider-widget .label { font-size: 13px; font-weight: 500; color: ${tokens.gray900}; }
.slider-widget .val { font-size: 13px; font-weight: 600; color: ${tokens.primary}; }
.slider-widget input[type="range"] { width: 100%; height: 6px; -webkit-appearance: none; appearance: none; background: ${tokens.gray200}; border-radius: 3px; outline: none; }
.slider-widget input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; border-radius: 50%; background: ${tokens.primary}; cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.2); }
</style></head><body>
<div class="slider-widget">
  <div class="header"><span class="label" id="lbl">Value</span><span class="val" id="val">0</span></div>
  <input type="range" id="slider" oninput="document.getElementById('val').textContent=this.value">
</div>
${widgetScript(
  "Slider",
  `
  var s = document.getElementById('slider');
  s.min = args.min !== undefined ? args.min : 0;
  s.max = args.max !== undefined ? args.max : 100;
  s.value = args.value !== undefined ? args.value : 50;
  document.getElementById('val').textContent = s.value;
  if (args.label) document.getElementById('lbl').textContent = args.label;
`,
)}
</body></html>`,
    exampleInput: { value: 75, min: 0, max: 100, label: "Volume" },
  },

  "ui://mesh/rating": {
    name: "Rating",
    description: "Star rating display with interactive selection",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.rating-widget { padding: 4px 0; }
.rating-widget .label { font-size: 13px; color: ${tokens.gray700}; margin-bottom: 8px; }
.rating-widget .stars { display: flex; gap: 4px; }
.rating-widget .star { font-size: 28px; cursor: pointer; color: ${tokens.gray200}; transition: color 0.15s; line-height: 1; }
.rating-widget .star.filled { color: #f59e0b; }
.rating-widget .star:hover { color: #fbbf24; }
</style></head><body>
<div class="rating-widget">
  <div class="label" id="lbl">Rating</div>
  <div class="stars" id="stars"></div>
</div>
${widgetScript(
  "Rating",
  `
  if (args.label) document.getElementById('lbl').textContent = args.label;
  var mx = args.max || 5, val = args.value || 0;
  var c = document.getElementById('stars');
  c.innerHTML = '';
  for (var i = 1; i <= mx; i++) {
    var s = document.createElement('span');
    s.className = 'star' + (i <= val ? ' filled' : '');
    s.textContent = '\\u2605';
    s.dataset.idx = i;
    s.addEventListener('click', function() {
      var idx = parseInt(this.dataset.idx);
      var all = c.querySelectorAll('.star');
      all.forEach(function(el) { el.className = 'star' + (parseInt(el.dataset.idx) <= idx ? ' filled' : ''); });
    });
    c.appendChild(s);
  }
`,
)}
</body></html>`,
    exampleInput: { value: 4, max: 5, label: "Product Rating" },
  },

  "ui://mesh/kbd": {
    name: "Keyboard Shortcuts",
    description: "Display keyboard shortcuts with key combinations",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.kbd-widget { padding: 4px 0; }
.kbd-widget .row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid ${tokens.gray100}; }
.kbd-widget .row:last-child { border-bottom: none; }
.kbd-widget .desc { font-size: 13px; color: ${tokens.gray700}; }
.kbd-widget .keys { display: flex; gap: 4px; }
.kbd-widget kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 28px; height: 26px; padding: 0 8px; font-family: ${tokens.fontMono}; font-size: 12px; background: ${tokens.gray100}; border: 1px solid ${tokens.gray300}; border-radius: 5px; box-shadow: 0 1px 0 ${tokens.gray300}; }
.kbd-widget .plus { color: ${tokens.gray700}; font-size: 11px; }
</style></head><body>
<div class="kbd-widget" id="list"></div>
${widgetScript(
  "Keyboard Shortcuts",
  `
  var c = document.getElementById('list');
  c.innerHTML = '';
  (args.shortcuts || []).forEach(function(s) {
    var row = document.createElement('div'); row.className = 'row';
    var desc = document.createElement('span'); desc.className = 'desc'; desc.textContent = s.description || '';
    var keys = document.createElement('span'); keys.className = 'keys';
    (s.keys || []).forEach(function(k, i) {
      if (i > 0) { var p = document.createElement('span'); p.className = 'plus'; p.textContent = '+'; keys.appendChild(p); }
      var kbd = document.createElement('kbd'); kbd.textContent = k; keys.appendChild(kbd);
    });
    row.appendChild(desc); row.appendChild(keys); c.appendChild(row);
  });
`,
)}
</body></html>`,
    exampleInput: {
      shortcuts: [
        { keys: ["Ctrl", "C"], description: "Copy" },
        { keys: ["Ctrl", "V"], description: "Paste" },
      ],
    },
  },

  "ui://mesh/stats-grid": {
    name: "Stats Grid",
    description: "Dashboard grid of stat cards with trends",
    borderless: true,
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.stats-grid .card { padding: 14px; background: ${tokens.gray100}; border-radius: ${tokens.borderRadius}; }
.stats-grid .card .label { font-size: 11px; color: ${tokens.gray700}; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.stats-grid .card .row { display: flex; align-items: baseline; gap: 4px; }
.stats-grid .card .unit { font-size: 16px; color: ${tokens.gray700}; font-weight: 600; }
.stats-grid .card .value { font-size: 24px; font-weight: 700; }
.stats-grid .card .trend { font-size: 12px; font-weight: 600; margin-top: 4px; }
.stats-grid .card .trend.up { color: ${tokens.success}; }
.stats-grid .card .trend.down { color: ${tokens.danger}; }
</style></head><body>
<div class="stats-grid" id="grid"></div>
${widgetScript(
  "Stats Grid",
  `
  var g = document.getElementById('grid');
  g.innerHTML = '';
  (args.stats || []).forEach(function(s) {
    var c = document.createElement('div'); c.className = 'card';
    var lbl = '<div class="label">' + escH(s.label || '') + '</div>';
    var u = s.unit || '';
    var v = isNaN(Number(s.value)) ? escH(String(s.value||'—')) : Number(s.value).toLocaleString();
    var isPrefix = u.length <= 1;
    var row = '<div class="row">' + (isPrefix ? '<span class="unit">' + escH(u) + '</span>' : '') + '<span class="value">' + v + '</span>' + (!isPrefix ? '<span class="unit">' + escH(u) + '</span>' : '') + '</div>';
    var trend = '';
    if (s.trend !== undefined) {
      var up = s.trend >= 0;
      trend = '<div class="trend ' + (up?'up':'down') + '">' + (up?'\\u25B2 +':'\\u25BC ') + s.trend + '%</div>';
    }
    c.innerHTML = lbl + row + trend; g.appendChild(c);
  });
`,
)}
<script>function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}</script>
</body></html>`,
    exampleInput: {
      stats: [
        { label: "Users", value: 1234, unit: "", trend: 5.2 },
        { label: "Revenue", value: 56789, unit: "$", trend: -2.1 },
      ],
    },
  },

  "ui://mesh/area-chart": {
    name: "Area Chart",
    description: "Area chart for time-series data visualization",
    html:
      `<!DOCTYPE html><html><head><style>${baseCSS}
.area-chart { padding: 4px 0; position: relative; }
.area-chart .title { font-size: 14px; font-weight: 600; margin-bottom: 14px; }
.area-chart svg { display: block; width: 100%; cursor: crosshair; }
.area-chart .tip { position: absolute; pointer-events: none; background: ${tokens.gray900}; color: white; font-size: 11px; padding: 3px 8px; border-radius: 4px; white-space: nowrap; display: none; z-index: 10; transform: translate(-50%, 0); }
</style></head><body>
<div class="area-chart" id="wrap">
  <div class="title" id="title">Chart</div>
  <svg id="svg"></svg>
  <div class="tip" id="tip"></div>
</div>
${widgetScript(
  "Area Chart",
  `
  if (args.title) document.getElementById('title').textContent = args.title;
  var data = args.data || [];
  if (!data.length) return;
  var vals = data.map(function(d){return d.value||0;});
  var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
  var range = mx - mn || 1;
  var rawStep = range / 3;
  var mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  var niceStep = [1,2,5,10].reduce(function(b,n){var s=n*mag;return Math.abs(range/s-3)<Math.abs(range/b-3)?s:b;},mag)||1;
  var yMin = Math.floor(mn/niceStep)*niceStep;
  var yMax = Math.ceil(mx/niceStep)*niceStep;
  var yRange = yMax - yMin || 1;
  var yTicks = [];
  for (var y = yMin; y <= yMax; y += niceStep) yTicks.push(Math.round(y*1e6)/1e6);
  if (yTicks.length > 5) yTicks = [yTicks[0], yTicks[Math.round(yTicks.length/2)], yTicks[yTicks.length-1]];
  var maxLen = Math.max.apply(null, yTicks.map(function(v){return String(v).length;}));
  var svg = document.getElementById('svg');
  var TW = svg.clientWidth || svg.getBoundingClientRect().width || 500;
  var LM = maxLen * 8 + 8;
  var padT = 6, chartH = Math.min(TW * 0.28, 120), xAxisY = padT + chartH, TH = xAxisY + 20;
  var chartW = TW - LM;
  svg.setAttribute('viewBox', '0 0 ' + TW + ' ' + TH);
  var step = chartW / (vals.length - 1 || 1);
  var pts = vals.map(function(v, i) {
    return { x: LM + i * step, y: padT + chartH - ((v - yMin) / yRange) * chartH };
  });
  var grid = yTicks.map(function(v) {
    var gy = padT + chartH - ((v - yMin) / yRange) * chartH;
    return '<line x1="'+LM+'" y1="'+gy.toFixed(1)+'" x2="'+TW+'" y2="'+gy.toFixed(1)+'" stroke="${tokens.gray200}" stroke-width="0.5"/>' +
      '<text x="'+(LM-4)+'" y="'+(gy+3).toFixed(1)+'" text-anchor="end" font-size="11" fill="${tokens.gray500}">'+v+'</text>';
  }).join('');
  var linePath = pts.map(function(p){return p.x.toFixed(1)+','+p.y.toFixed(1);}).join(' L');
  var areaPath = 'M'+LM+','+xAxisY+' L'+linePath+' L'+pts[pts.length-1].x.toFixed(1)+','+xAxisY+' Z';
  var last = data.length - 1;
  var xLabels = data.map(function(d, i) {
    var a = i===0?'start':i===last?'end':'middle';
    return '<text x="'+(LM+i*step).toFixed(1)+'" y="'+(TH-1)+'" text-anchor="'+a+'" font-size="11" fill="${tokens.gray500}">'+escH(d.label||'')+'</text>';
  }).join('');
  var circles = pts.map(function(p,i){
    return '<circle class="dot" cx="'+p.x.toFixed(1)+'" cy="'+p.y.toFixed(1)+'" r="3" fill="${tokens.primary}" stroke="white" stroke-width="1.5" opacity="0" data-i="'+i+'"/>';
  }).join('');
  svg.innerHTML = '<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${tokens.primary}" stop-opacity="0.15"/><stop offset="100%" stop-color="${tokens.primary}" stop-opacity="0.01"/></linearGradient></defs>' +
    grid +
    '<path d="'+areaPath+'" fill="url(#ag)"/>' +
    '<path d="M'+linePath+'" fill="none" stroke="${tokens.primary}" stroke-width="1.5"/>' +
    '<line id="vline" x1="0" y1="'+padT+'" x2="0" y2="'+xAxisY+'" stroke="${tokens.gray300}" stroke-width="0.5" stroke-dasharray="2,2" opacity="0"/>' +
    circles + xLabels +
    '<rect x="'+LM+'" y="0" width="'+chartW+'" height="'+xAxisY+'" fill="transparent" id="hover"/>';
  var tip = document.getElementById('tip');
  var vline = document.getElementById('vline');
  var dots = svg.querySelectorAll('.dot');
  var activeI = -1;
  document.getElementById('hover').addEventListener('mousemove', function(e) {
    var rect = svg.getBoundingClientRect();
    var sx = (e.clientX - rect.left) / rect.width * TW;
    var closest = 0, minD = Infinity;
    pts.forEach(function(p,i){ var d = Math.abs(p.x - sx); if(d < minD){minD=d;closest=i;} });
    if (closest === activeI) return;
    activeI = closest;
    dots.forEach(function(d,i){d.setAttribute('opacity', i===closest?'1':'0');});
    vline.setAttribute('x1', pts[closest].x.toFixed(1));
    vline.setAttribute('x2', pts[closest].x.toFixed(1));
    vline.setAttribute('opacity', '1');
    tip.textContent = vals[closest];
    tip.style.display = 'block';
    var pr = document.getElementById('wrap').getBoundingClientRect();
    var px = pts[closest].x / TW * rect.width + rect.left - pr.left;
    var py = pts[closest].y / TH * rect.height + rect.top - pr.top - 24;
    var pctX = pts[closest].x / TW;
    tip.style.transform = pctX < 0.15 ? 'translate(0, 0)' : pctX > 0.85 ? 'translate(-100%, 0)' : 'translate(-50%, 0)';
    tip.style.left = px + 'px';
    tip.style.top = py + 'px';
  });
  document.getElementById('hover').addEventListener('mouseleave', function() {
    activeI = -1;
    dots.forEach(function(d){d.setAttribute('opacity','0');});
    vline.setAttribute('opacity', '0');
    tip.style.display = 'none';
  });
`,
)}
<scr` +
      `ipt>function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}</scr` +
      `ipt>
</body></html>`,
    exampleInput: {
      data: [
        { label: "Mon", value: 10 },
        { label: "Tue", value: 25 },
        { label: "Wed", value: 15 },
        { label: "Thu", value: 30 },
        { label: "Fri", value: 20 },
      ],
      title: "Traffic",
    },
  },

  "ui://mesh/calendar": {
    name: "Calendar",
    description: "Mini calendar with highlighted dates",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.cal { padding: 4px 0; max-width: 280px; }
.cal .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
.cal .header .month { font-size: 15px; font-weight: 600; }
.cal .header button { background: none; border: 1px solid ${tokens.gray300}; border-radius: 4px; width: 28px; height: 28px; cursor: pointer; font-size: 14px; color: ${tokens.gray700}; display: flex; align-items: center; justify-content: center; }
.cal .grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; text-align: center; }
.cal .dow { font-size: 11px; color: ${tokens.gray700}; font-weight: 600; padding: 4px 0; }
.cal .day { font-size: 13px; padding: 6px 0; border-radius: 6px; cursor: default; }
.cal .day.today { background: ${tokens.primary}; color: white; font-weight: 600; }
.cal .day.highlight { background: #e0e7ff; color: ${tokens.primary}; font-weight: 600; }
.cal .day.empty { visibility: hidden; }
</style></head><body>
<div class="cal">
  <div class="header">
    <button onclick="changeMonth(-1)">&#x2190;</button>
    <span class="month" id="monthLabel"></span>
    <button onclick="changeMonth(1)">&#x2192;</button>
  </div>
  <div class="grid" id="grid"></div>
</div>
${widgetScript(
  "Calendar",
  `
  window._calMonth = args.month !== undefined ? args.month - 1 : new Date().getMonth();
  window._calYear = args.year || new Date().getFullYear();
  window._calHighlight = args.highlightedDates || [];
  renderCal();
`,
)}
<script>
var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var dows = ['Su','Mo','Tu','We','Th','Fr','Sa'];
function renderCal() {
  var m = window._calMonth, y = window._calYear;
  document.getElementById('monthLabel').textContent = months[m] + ' ' + y;
  var g = document.getElementById('grid');
  g.innerHTML = '';
  dows.forEach(function(d) { var el = document.createElement('div'); el.className = 'dow'; el.textContent = d; g.appendChild(el); });
  var first = new Date(y, m, 1).getDay();
  var days = new Date(y, m + 1, 0).getDate();
  var today = new Date();
  for (var i = 0; i < first; i++) { var e = document.createElement('div'); e.className = 'day empty'; e.textContent = '.'; g.appendChild(e); }
  for (var d = 1; d <= days; d++) {
    var el = document.createElement('div'); el.className = 'day';
    if (d === today.getDate() && m === today.getMonth() && y === today.getFullYear()) el.className += ' today';
    else if (window._calHighlight.indexOf(d) !== -1) el.className += ' highlight';
    el.textContent = d; g.appendChild(el);
  }
  ${notifySize()}
}
function changeMonth(dir) {
  window._calMonth += dir;
  if (window._calMonth > 11) { window._calMonth = 0; window._calYear++; }
  if (window._calMonth < 0) { window._calMonth = 11; window._calYear--; }
  renderCal();
}
</script>
</body></html>`,
    exampleInput: { month: 2, year: 2026, highlightedDates: [14, 20, 25] },
  },
};

export function getUIWidgetResource(uri: string): UIWidgetResource | undefined {
  return UI_WIDGET_RESOURCES[uri];
}

export function listUIWidgetResources(): Array<{
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  exampleInput: Record<string, unknown>;
}> {
  return Object.entries(UI_WIDGET_RESOURCES).map(([uri, resource]) => ({
    uri,
    name: resource.name,
    description: resource.description,
    mimeType: RESOURCE_MIME_TYPE,
    exampleInput: resource.exampleInput,
  }));
}
