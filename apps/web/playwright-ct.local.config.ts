import base from "./playwright-ct.config";
export default { ...base, workers: 4, reporter: "line" as const, projects: [{ name: "chrome", use: { channel: "chrome" as const } }] };
