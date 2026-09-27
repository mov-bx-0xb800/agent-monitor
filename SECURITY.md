# Security policy

Agent Monitor is a development preview.

## Reporting a vulnerability

Report security problems privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, or go to [the private report form](https://github.com/mov-bx-0xb800/agent-monitor/security/advisories/new). Only the maintainers can see the report. Please do not open a public issue for a security problem, and do not post credentials, transcripts, real hook payloads or private screenshots anywhere public.

The extension receives local agent events and can modify hook settings when a user connects or disconnects an adapter. It does not override workspace trust, native hook trust or organisation policy. Paths, short prompt-derived labels and image content may be sensitive; see [Privacy](docs/PRIVACY.md).

Security boundaries include hook-command quoting, preservation of unrelated settings, event parsing limits, workspace path containment, raster dimensions, bounded storage, exact-recipient steering and the webview content security policy. Tests exercise these boundaries but do not replace independent review or native platform acceptance.

Do not attach the application-data directory or settings backups to a report. A useful de-identified report describes the affected version, relevant host/platform, minimal synthetic reproduction, expected/actual behaviour and impact. Maintainers should reproduce sensitive issues in a disposable workspace and avoid collecting unrelated user data.
