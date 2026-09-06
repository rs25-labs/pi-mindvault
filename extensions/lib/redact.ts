const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9-_]{8,}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /gho_[A-Za-z0-9]{8,}/g,
  /xox[bpas]-[A-Za-z0-9-]{8,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /(?<=api[_-]?key\s*[:=]\s*)[A-Za-z0-9-_.]{12,}/gi,
];

export function redact(input: string, opts?: { cwd?: string }): string {
  let out = input;
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[redacted]");
  }
  // jail absolute system paths outside the working tree
  out = out.replace(/(^|[\s"'(`])(?:\/etc\/[^\s"'`)]*|\/private\/[^\s"'`)]*)/g, "$1<outside-cwd>");
  const cwd = opts?.cwd ?? "";
  if (cwd && !cwd.startsWith("<")) {
    // mark any other home-rooted absolute path that is not under cwd
    out = out.replace(/(^|[\s"'(`])(\/(?:home|tmp|var)[^\s"'`)]*)/g, (m, pre, p: string) => {
      if (cwd && p.startsWith(cwd)) return m;
      return `${pre}<outside-cwd>`;
    });
  }
  return out;
}
