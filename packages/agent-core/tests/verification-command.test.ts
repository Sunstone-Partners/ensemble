import { verificationCommand } from "../src/behavior/event-translator";

/**
 * br-c3s4: verification re-ran the whole && chain and re-applied the bug.
 *
 * The first case is the exact command from the live incident.
 */

describe("verificationCommand", () => {
  it("drops the mutation step that broke the tests", () => {
    const captured =
      `cd packages/agent-core && python3 -c "` +
      `p='src/behavior/outbox.ts'\ns=open(p).read()\n` +
      `open(p,'w').write(s.replace('a + b','a - b'))" ` +
      `&& sed -n '18,21p' src/behavior/outbox.ts && npx jest outbox`;

    const scoped = verificationCommand(captured);

    expect(scoped).toBe("cd packages/agent-core && npx jest outbox");
    expect(scoped).not.toContain("python3");
    expect(scoped).not.toContain("replace");
  });

  it("keeps the directory change, so the re-run happens where it failed", () => {
    // Dropping the cd would run at the repo root, match zero tests and
    // "pass" -- the false pass verify-suite.ts already guards against.
    expect(verificationCommand("cd packages/pi-extension && npx jest approve")).toBe(
      "cd packages/pi-extension && npx jest approve",
    );
  });

  it("leaves an ordinary test command untouched", () => {
    expect(verificationCommand("npx jest")).toBe("npx jest");
  });

  it("drops a pipe that would mask the exit status", () => {
    // `npx jest | tail -20` reports tail's status, not jest's -- the
    // pipe-masking failure that disabled autofix once already.
    expect(verificationCommand("npx jest 2>&1 | tail -20")).toBe("npx jest 2>&1");
  });

  it.each([
    ["a file restore", "cp /tmp/bak src/x.ts && npx jest"],
    ["an in-place edit", "sed -i 's/a/b/' src/x.ts && npx jest"],
    ["a git checkout", "git checkout -- src/x.ts && npx jest"],
  ])("drops %s", (_label, captured) => {
    expect(verificationCommand(captured)).toBe("npx jest");
  });

  it("returns undefined when nothing testable survives", () => {
    // Refusing to grade is the point: the caller reports "inconclusive",
    // which does not roll back, rather than grading the wrong command.
    expect(verificationCommand("git status --short; ls tests src")).toBeUndefined();
    expect(verificationCommand("cd packages/agent-core")).toBeUndefined();
  });

  it("is not fooled by a runner named as an argument", () => {
    expect(verificationCommand("cat jest.config.js")).toBeUndefined();
  });
});
