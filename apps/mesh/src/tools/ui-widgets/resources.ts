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
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: ${tokens.fontFamily}; font-size: ${tokens.fontSize}; color: ${tokens.gray900}; background: transparent; padding: 16px; line-height: 1.5; }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e7eb; }
  }
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
  html: string;
  exampleInput: Record<string, unknown>;
}

const UI_WIDGET_RESOURCES: Record<string, UIWidgetResource> = {
  "ui://mesh/counter": {
    name: "Counter",
    description: "Interactive counter widget with increment/decrement controls",
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.counter { text-align: center; }
.counter .label { font-size: 13px; color: ${tokens.gray500}; margin-bottom: 8px; }
.counter .value { font-size: 48px; font-weight: 700; color: ${tokens.primary}; margin: 12px 0; }
.counter .controls { display: flex; gap: 8px; justify-content: center; }
.counter button { width: 40px; height: 40px; border-radius: ${tokens.borderRadius}; border: 1px solid ${tokens.gray200}; background: white; font-size: 20px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
.counter button:hover { background: ${tokens.primary}; color: white; border-color: ${tokens.primary}; }
@media (prefers-color-scheme: dark) {
  .counter button { background: #1f2937; border-color: #374151; color: #e5e7eb; }
  .counter button:hover { background: ${tokens.primary}; border-color: ${tokens.primary}; color: white; }
}
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
.metric { padding: 8px 0; }
.metric .label { font-size: 12px; color: ${tokens.gray500}; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.metric .row { display: flex; align-items: baseline; gap: 4px; }
.metric .unit { font-size: 24px; font-weight: 600; color: ${tokens.gray500}; }
.metric .value { font-size: 36px; font-weight: 700; }
.metric .trend { font-size: 13px; font-weight: 600; margin-top: 6px; display: flex; align-items: center; gap: 4px; }
.metric .trend.up { color: ${tokens.success}; }
.metric .trend.down { color: ${tokens.danger}; }
</style></head><body>
<div class="metric">
  <div class="label" id="lbl">Metric</div>
  <div class="row"><span class="unit" id="unit"></span><span class="value" id="val">0</span></div>
  <div class="trend" id="trend"></div>
</div>
${widgetScript(
  "Metric",
  `
  if (args.label) document.getElementById('lbl').textContent = args.label;
  if (args.value !== undefined) document.getElementById('val').textContent = Number(args.value).toLocaleString();
  document.getElementById('unit').textContent = args.unit || '';
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
.progress .pct { font-size: 13px; color: ${tokens.gray500}; }
.progress .track { height: 8px; background: ${tokens.gray100}; border-radius: 4px; overflow: hidden; }
.progress .fill { height: 100%; background: linear-gradient(90deg, ${tokens.primary}, ${tokens.primaryLight}); border-radius: 4px; transition: width 0.5s ease; }
@media (prefers-color-scheme: dark) {
  .progress .track { background: #1f2937; }
  .progress .pct { color: #d1d5db; }
}
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
.chart .bar-label { font-size: 11px; color: ${tokens.gray500}; margin-top: 6px; text-align: center; }
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
.timer { text-align: center; }
.timer .label { font-size: 13px; color: ${tokens.gray500}; margin-bottom: 8px; }
.timer .display { font-size: 42px; font-weight: 700; font-family: ${tokens.fontMono}; letter-spacing: 2px; margin: 8px 0 16px; }
.timer .controls { display: flex; gap: 8px; justify-content: center; }
.timer button { padding: 6px 16px; border-radius: 6px; border: none; font-size: 13px; font-weight: 500; cursor: pointer; transition: opacity 0.15s; }
.timer .start { background: ${tokens.success}; color: white; }
.timer .pause { background: ${tokens.warning}; color: white; }
.timer .reset { background: ${tokens.gray200}; color: ${tokens.gray700}; }
.timer button:hover { opacity: 0.85; }
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
  window._timerDuration = (args.duration || 60);
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
@media (prefers-color-scheme: dark) {
  .status { background: #1f2937; }
  .status .text { color: #e5e7eb; }
}
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
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.quote { padding: 16px 20px; border-left: 3px solid ${tokens.primary}; background: ${tokens.gray100}; border-radius: 0 ${tokens.borderRadius} ${tokens.borderRadius} 0; }
.quote .text { font-size: 16px; font-style: italic; line-height: 1.6; color: ${tokens.gray700}; }
.quote .author { font-size: 13px; color: ${tokens.gray500}; margin-top: 10px; }
.quote .author::before { content: '\\2014\\00A0'; }
@media (prefers-color-scheme: dark) {
  .quote { background: #1f2937; }
  .quote .text { color: #d1d5db; }
  .quote .author { color: #9ca3af; }
}
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
.sparkline .label { font-size: 13px; color: ${tokens.gray500}; margin-bottom: 8px; }
.sparkline svg { display: block; width: 100%; }
</style></head><body>
<div class="sparkline">
  <div class="label" id="lbl">Trend</div>
  <svg id="svg" viewBox="0 0 200 50" preserveAspectRatio="none" height="50"></svg>
</div>
${widgetScript(
  "Sparkline",
  `
  if (args.label) document.getElementById('lbl').textContent = args.label;
  var vals = args.values || [];
  if (!vals.length) return;
  var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals);
  var range = mx - mn || 1;
  var step = 200 / (vals.length - 1 || 1);
  var pts = vals.map(function(v, i) { return (i * step).toFixed(1) + ',' + (50 - ((v - mn) / range) * 46 - 2).toFixed(1); });
  var svg = document.getElementById('svg');
  var areaPath = 'M0,50 L' + pts.join(' L') + ' L200,50 Z';
  var linePath = 'M' + pts.join(' L');
  svg.innerHTML = '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${tokens.primary}" stop-opacity="0.3"/><stop offset="100%" stop-color="${tokens.primary}" stop-opacity="0"/></linearGradient></defs><path d="' + areaPath + '" fill="url(#g)"/><path d="' + linePath + '" fill="none" stroke="${tokens.primary}" stroke-width="2"/>';
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
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.code-block { background: #1e1e2e; border-radius: ${tokens.borderRadius}; overflow: hidden; }
.code-block .header { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: #181825; }
.code-block .lang { font-size: 11px; color: #a6adc8; text-transform: uppercase; letter-spacing: 0.05em; }
.code-block .copy { font-size: 11px; color: #a6adc8; background: none; border: 1px solid #313244; border-radius: 4px; padding: 2px 8px; cursor: pointer; }
.code-block .copy:hover { background: #313244; }
.code-block pre { padding: 12px 16px; overflow-x: auto; }
.code-block code { font-family: ${tokens.fontMono}; font-size: 13px; color: #cdd6f4; line-height: 1.6; white-space: pre; }
</style></head><body>
<div class="code-block">
  <div class="header"><span class="lang" id="lang">code</span><button class="copy" onclick="copyCode()">Copy</button></div>
  <pre><code id="code"></code></pre>
</div>
${widgetScript(
  "Code",
  `
  document.getElementById('code').textContent = args.code || '';
  document.getElementById('lang').textContent = args.language || 'text';
`,
)}
<script>
function copyCode() {
  var t = document.getElementById('code').textContent;
  navigator.clipboard.writeText(t).catch(function(){});
}
</script>
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
.confirm .msg { font-size: 14px; color: ${tokens.gray500}; margin-bottom: 16px; line-height: 1.5; }
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
.json-viewer .null { color: ${tokens.gray500}; }
.json-viewer .bracket { color: ${tokens.gray500}; }
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
@media (prefers-color-scheme: dark) {
  .tbl th { background: #1f2937; border-color: #374151; }
  .tbl td { border-color: #1f2937; }
  .tbl tr:hover td { background: #111827; }
}
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
.diff .before .pane-body { background: #fef2f2; }
.diff .after .pane-body { background: #f0fdf4; }
@media (prefers-color-scheme: dark) {
  .diff .before .pane-header { background: #450a0a; color: #fca5a5; }
  .diff .after .pane-header { background: #052e16; color: #86efac; }
  .diff .before .pane-body { background: #1c0a0a; border-color: #374151; }
  .diff .after .pane-body { background: #0a1c0f; border-color: #374151; }
}
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
.todo .item .text.done { text-decoration: line-through; color: ${tokens.gray500}; }
@media (prefers-color-scheme: dark) {
  .todo .item { border-color: #1f2937; }
  .todo .item .text.done { color: #9ca3af; }
}
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
.md .title-bar { font-size: 12px; color: ${tokens.gray500}; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid ${tokens.gray100}; }
.md .content h1 { font-size: 24px; font-weight: 700; margin: 16px 0 8px; }
.md .content h2 { font-size: 20px; font-weight: 600; margin: 14px 0 6px; }
.md .content h3 { font-size: 16px; font-weight: 600; margin: 12px 0 4px; }
.md .content p { margin: 8px 0; line-height: 1.6; }
.md .content strong { font-weight: 600; }
.md .content em { font-style: italic; }
.md .content code { font-family: ${tokens.fontMono}; background: ${tokens.gray100}; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
.md .content ul, .md .content ol { padding-left: 24px; margin: 8px 0; }
.md .content li { margin: 4px 0; }
.md .content blockquote { border-left: 3px solid ${tokens.primary}; padding-left: 12px; color: ${tokens.gray500}; margin: 8px 0; }
@media (prefers-color-scheme: dark) {
  .md .title-bar { border-color: #374151; }
  .md .content code { background: #1f2937; }
  .md .content blockquote { color: #9ca3af; }
}
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
    .replace(/^(?!<[hbulo])(.+)$/gm, '<p>$1</p>');
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
.img-widget .caption { font-size: 12px; color: ${tokens.gray500}; margin-top: 8px; }
.img-widget .alt { font-size: 13px; color: ${tokens.gray500}; padding: 24px; border: 2px dashed ${tokens.gray200}; border-radius: ${tokens.borderRadius}; }
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
    c.innerHTML = '<img src="' + args.src.replace(/"/g, '&quot;') + '" alt="' + (args.alt || '').replace(/"/g, '&quot;') + '">';
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
      src: "https://via.placeholder.com/400x200",
      alt: "Placeholder",
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
@media (prefers-color-scheme: dark) {
  .form-result .header .title { color: #f9fafb; }
  .form-result .header .icon.ok { background: #166534; color: #dcfce7; }
  .form-result .header .icon.fail { background: #991b1b; color: #fee2e2; }
  .form-result .field { background: #374151; }
  .form-result .field .label { color: #d1d5db; }
  .form-result .field .value { color: #f9fafb; }
}
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
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.error-widget { padding: 12px 16px; border-radius: ${tokens.borderRadius}; border: 1px solid #fca5a5; background: #fef2f2; }
.error-widget .header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.error-widget .icon { color: ${tokens.danger}; font-size: 18px; }
.error-widget .msg { font-size: 15px; font-weight: 600; color: #991b1b; }
.error-widget .code { font-size: 11px; font-family: ${tokens.fontMono}; color: #b91c1c; background: #fee2e2; padding: 2px 8px; border-radius: 4px; margin-top: 4px; display: inline-block; }
.error-widget .details { font-size: 13px; color: #7f1d1d; margin-top: 8px; line-height: 1.5; }
@media (prefers-color-scheme: dark) {
  .error-widget { background: #450a0a; border-color: #7f1d1d; }
  .error-widget .msg { color: #fca5a5; }
  .error-widget .code { background: #7f1d1d; color: #fecaca; }
  .error-widget .details { color: #fecaca; }
}
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
@media (prefers-color-scheme: dark) {
  .notif.success { background: #052e16; border-color: #166534; }
  .notif.error { background: #450a0a; border-color: #991b1b; }
  .notif.warning { background: #451a03; border-color: #92400e; }
  .notif.info { background: #172554; border-color: #1e40af; }
  .notif.success .body .title { color: #86efac; }
  .notif.error .body .title { color: #fca5a5; }
  .notif.warning .body .title { color: #fcd34d; }
  .notif.info .body .title { color: #93c5fd; }
}
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
.avatar-widget .info .status-text { font-size: 12px; color: ${tokens.gray500}; }
@media (prefers-color-scheme: dark) {
  .avatar-widget .status-dot { border-color: #111827; }
  .avatar-widget .info .status-text { color: #9ca3af; }
  .avatar-widget .info .name { color: #f9fafb; }
}
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
.switch-widget { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.switch-widget .text .label { font-size: 14px; font-weight: 500; }
.switch-widget .text .desc { font-size: 12px; color: ${tokens.gray500}; margin-top: 2px; }
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
.slider-widget .label { font-size: 13px; font-weight: 500; }
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
.rating-widget .label { font-size: 13px; color: ${tokens.gray500}; margin-bottom: 8px; }
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
.kbd-widget .plus { color: ${tokens.gray500}; font-size: 11px; }
@media (prefers-color-scheme: dark) {
  .kbd-widget .row { border-color: #1f2937; }
  .kbd-widget .desc { color: #d1d5db; }
  .kbd-widget kbd { background: #1f2937; border-color: #374151; box-shadow: 0 1px 0 #374151; color: #e5e7eb; }
}
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
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
.stats-grid .card { padding: 14px; background: ${tokens.gray100}; border-radius: ${tokens.borderRadius}; }
.stats-grid .card .label { font-size: 11px; color: ${tokens.gray500}; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
.stats-grid .card .row { display: flex; align-items: baseline; gap: 4px; }
.stats-grid .card .unit { font-size: 16px; color: ${tokens.gray500}; font-weight: 600; }
.stats-grid .card .value { font-size: 24px; font-weight: 700; }
.stats-grid .card .trend { font-size: 12px; font-weight: 600; margin-top: 4px; }
.stats-grid .card .trend.up { color: ${tokens.success}; }
.stats-grid .card .trend.down { color: ${tokens.danger}; }
@media (prefers-color-scheme: dark) {
  .stats-grid .card { background: #1f2937; }
  .stats-grid .card .label { color: #9ca3af; }
  .stats-grid .card .value { color: #f9fafb; }
}
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
    var row = '<div class="row"><span class="unit">' + escH(u) + '</span><span class="value">' + Number(s.value||0).toLocaleString() + '</span></div>';
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
    html: `<!DOCTYPE html><html><head><style>${baseCSS}
.area-chart { padding: 4px 0; }
.area-chart .title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.area-chart svg { display: block; width: 100%; }
.area-chart .labels { display: flex; justify-content: space-between; margin-top: 4px; }
.area-chart .labels span { font-size: 11px; color: ${tokens.gray500}; }
</style></head><body>
<div class="area-chart">
  <div class="title" id="title">Chart</div>
  <svg id="svg" viewBox="0 0 300 100" preserveAspectRatio="none" height="100"></svg>
  <div class="labels" id="labels"></div>
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
  var W = 300, H = 100, padT = 5, padB = 5;
  var step = W / (vals.length - 1 || 1);
  var pts = vals.map(function(v, i) {
    return { x: (i * step).toFixed(1), y: (H - padB - ((v - mn) / range) * (H - padT - padB)).toFixed(1) };
  });
  var line = pts.map(function(p){return p.x+','+p.y;}).join(' L');
  var area = 'M0,' + H + ' L' + line + ' L' + W + ',' + H + ' Z';
  var svg = document.getElementById('svg');
  svg.innerHTML = '<defs><linearGradient id="ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${tokens.primary}" stop-opacity="0.4"/><stop offset="100%" stop-color="${tokens.primary}" stop-opacity="0.05"/></linearGradient></defs>' +
    '<path d="' + area + '" fill="url(#ag)"/>' +
    '<path d="M' + line + '" fill="none" stroke="${tokens.primary}" stroke-width="2"/>' +
    pts.map(function(p){return '<circle cx="'+p.x+'" cy="'+p.y+'" r="3" fill="${tokens.primary}"/>';}).join('');
  var lb = document.getElementById('labels');
  lb.innerHTML = data.map(function(d){return '<span>'+escH(d.label||'')+'</span>';}).join('');
`,
)}
<script>function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}</script>
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
.cal .header button { background: none; border: 1px solid ${tokens.gray200}; border-radius: 4px; width: 28px; height: 28px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; }
.cal .grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; text-align: center; }
.cal .dow { font-size: 11px; color: ${tokens.gray500}; font-weight: 600; padding: 4px 0; }
.cal .day { font-size: 13px; padding: 6px 0; border-radius: 6px; cursor: default; }
.cal .day.today { background: ${tokens.primary}; color: white; font-weight: 600; }
.cal .day.highlight { background: #e0e7ff; color: ${tokens.primary}; font-weight: 600; }
.cal .day.empty { visibility: hidden; }
@media (prefers-color-scheme: dark) {
  .cal .header button { border-color: #374151; color: #e5e7eb; }
  .cal .day.highlight { background: #312e81; color: #c7d2fe; }
}
</style></head><body>
<div class="cal">
  <div class="header">
    <button onclick="changeMonth(-1)">&lsaquo;</button>
    <span class="month" id="monthLabel"></span>
    <button onclick="changeMonth(1)">&rsaquo;</button>
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
