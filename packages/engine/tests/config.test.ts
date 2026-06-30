import { describe, expect, it } from "vitest";
import { interpolateEnv, loadConfig } from "../src/config.js";

const VALID_YAML = `
version: 1
brand:
  name: Test
defaults:
  timeoutMs: 5000
groups:
  - id: g1
    name: Group One
sites:
  - name: Site One
    url: https://one.example.com
    group: g1
    ssl: true
  - name: Site One
    url: https://two.example.com
    domain: { warnDays: [10] }
channels:
  - id: tg
    type: telegram
    botToken: \${TG_TOKEN}
    chatId: "123"
    events: [down, up]
`;

describe("interpolateEnv", () => {
  it("substitutes present env vars", () => {
    const out = interpolateEnv("token: ${FOO}", { FOO: "secret" } as NodeJS.ProcessEnv);
    expect(out).toBe("token: secret");
  });

  it("leaves missing vars unresolved (never crashes)", () => {
    const out = interpolateEnv("token: ${MISSING_VAR}", {} as NodeJS.ProcessEnv);
    expect(out).toBe("token: ${MISSING_VAR}");
  });
});

describe("loadConfig", () => {
  it("parses a valid config, applies defaults, and derives unique ids", async () => {
    const cfg = await loadConfig({ rawYaml: VALID_YAML, cwd: "/tmp/pulse-test" });
    expect(cfg.sites).toHaveLength(2);
    // slugify("Site One") => "site-one"; duplicate gets "-2" suffix.
    expect(cfg.sites[0]!.id).toBe("site-one");
    expect(cfg.sites[1]!.id).toBe("site-one-2");
    // user default overrides shared default
    expect(cfg.defaults.timeoutMs).toBe(5000);
    // shared default retained where not overridden
    expect(cfg.defaults.retries).toBe(2);
    expect(cfg.defaults.maxHistoryPoints).toBeGreaterThan(0);
    // dataDir resolves relative to config dir
    expect(cfg.dataDir.endsWith("/data")).toBe(true);
    expect(cfg.groups).toHaveLength(1);
    expect(cfg.channels).toHaveLength(1);
  });

  it("defaults type=http and public=true", async () => {
    const cfg = await loadConfig({ rawYaml: VALID_YAML, cwd: "/tmp/pulse-test" });
    expect(cfg.sites[0]!.type).toBe("http");
    expect(cfg.sites[0]!.public).toBe(true);
    expect(cfg.sites[0]!.paused).toBe(false);
  });

  it("respects an explicit data-dir override", async () => {
    const cfg = await loadConfig({
      rawYaml: VALID_YAML,
      cwd: "/tmp/pulse-test",
      dataDir: "/abs/data",
    });
    expect(cfg.dataDir).toBe("/abs/data");
  });

  it("throws on a config with no sites", async () => {
    await expect(
      loadConfig({ rawYaml: "version: 1\nsites: []\n", cwd: "/tmp" }),
    ).rejects.toThrow(/at least one site/i);
  });

  it("throws on an invalid channel discriminant", async () => {
    const bad = `
sites:
  - name: x
    url: https://x.example.com
channels:
  - id: bad
    type: telegram
`;
    await expect(loadConfig({ rawYaml: bad, cwd: "/tmp" })).rejects.toThrow(/Invalid Pulse config/);
  });

  it("throws on a site missing a url", async () => {
    const bad = `
sites:
  - name: no-url
`;
    await expect(loadConfig({ rawYaml: bad, cwd: "/tmp" })).rejects.toThrow(/Invalid Pulse config/);
  });
});
