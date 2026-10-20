import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readWorkflow = (name: string): string =>
  readFileSync(resolve(process.cwd(), `.github/workflows/${name}.yml`), "utf8");
const cdWorkflow = readWorkflow("cd");
const ciWorkflow = readWorkflow("ci");
const packageMetadata = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as { repository: { url: string } };
const repository = new URL(packageMetadata.repository.url.replace(/^git\+/u, ""))
  .pathname.slice(1).replace(/\.git$/u, "");

describe("package release trust boundary", () => {
  it("uses exact-main hosted OIDC publication without write tokens", () => {
    expect(cdWorkflow).toContain("runs-on: ubuntu-latest");
    expect(cdWorkflow).not.toContain("self-hosted");
    expect(cdWorkflow).toContain("environment: production");
    expect(cdWorkflow).toContain("id-token: write");
    expect(cdWorkflow).toContain("Enforce exact-main successful CI");
    expect(cdWorkflow).toContain("refs/remotes/origin/main");
    expect(cdWorkflow).toContain("-f branch=main");
    expect(cdWorkflow).toContain("-f event=push");
    expect(cdWorkflow).toContain('-f head_sha="${EXPECTED_SHA}"');
    expect(cdWorkflow).toContain('conclusion == "success"');
    expect(cdWorkflow).toContain("Verify release runtime");
    expect(cdWorkflow).toContain('ACTUAL_NODE%%.*');
    expect(cdWorkflow).toContain('"11.5.1"');
    expect(cdWorkflow).toContain("--provenance");
    expect(cdWorkflow).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/u);
  });

  it("admits only repository pushes to quarantined self-hosted CI", () => {
    expect(ciWorkflow).toMatch(/on:\n {2}push:\n {4}branches: \["\*\*"\]/u);
    expect(ciWorkflow).not.toMatch(/pull_request|workflow_dispatch|workflow_call|inputs:/u);
    expect(ciWorkflow).not.toContain("ubuntu-latest");
    expect(ciWorkflow).not.toContain("fromJSON(");
    expect(ciWorkflow).toContain("cancel-in-progress: true");

    // Inspect every job, so adding another job cannot silently restore hosted
    // CI, bypass the event boundary, or call an unchecked reusable workflow.
    const jobs = (ciWorkflow.split("\njobs:\n")[1] ?? "")
      .split(/^ {2}(?=[a-zA-Z0-9_-]+:\s*$)/mu).slice(1);
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job).toContain("github.event_name == 'push'");
      expect(job).toContain(`github.repository == '${repository}'`);
      expect(job).toMatch(/runs-on:\n {6}group: Public CI - Quarantined\n {6}labels: \[self-hosted, Linux, X64\]/u);
      expect(job).toMatch(/timeout-minutes: (?:10|20)\n/u);
      expect(job).toContain("    steps:");
      expect(job).not.toMatch(/^ {4}uses:/mu);
    }
    expect(ciWorkflow).not.toMatch(/\n\s+cache:\s*["']?npm["']?/u);
    expect(ciWorkflow.match(/package-manager-cache: false/gu)).toHaveLength(jobs.length);
  });
});
