# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest  | Yes       |

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report them privately via one of the following:

- **GitHub private vulnerability reporting**: Go to the [Security](https://github.com/chiba233/yumeDSL/security/advisories/new) tab and click "Report a vulnerability".
- **Email**: Send details to the repository maintainer (see GitHub profile).

### What to include

1. Description of the vulnerability
2. Steps to reproduce
3. Affected version
4. Impact assessment (if known)

### What to expect

- Acknowledgment within **48 hours**
- Status update within **7 days**
- A fix or mitigation plan for confirmed vulnerabilities

## Scope

This policy covers `yume-dsl-rich-text`. It does **not** cover:

- Vulnerabilities in rendering layers you build on top of the parser (that's your application code)
- Denial of service via extremely large input — use `depthLimit` and input size limits in your application

## Known security considerations

- **URL sanitization**: The parser does not validate URLs. If you render `link` tags as `<a>` elements, sanitize the `url` field in your rendering layer (see the Vue 3 example in the README for a `normalizeUrl` reference implementation).
- **Raw content**: `raw` tag content is passed through as-is. If you render it as HTML, escape it appropriately.
