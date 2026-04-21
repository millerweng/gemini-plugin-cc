# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do not open a public issue for security vulnerabilities.**

Instead, email **momin.abrar@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce (if applicable)
- The potential impact
- Any suggested fix (if you have one)

You should receive a response within 72 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

## Scope

This policy covers the `gemini-plugin-cc` plugin code, including:

- ACP client and broker lifecycle
- Auth discovery and credential handling
- Stop-hook review gate
- Job state management
- All scripts in `plugins/gemini/scripts/`

## Out of Scope

- Vulnerabilities in the Gemini CLI itself (report to [Google](https://github.com/google-gemini/gemini-cli))
- Vulnerabilities in Claude Code (report to [Anthropic](https://github.com/anthropics/claude-code))
- Issues with third-party dependencies not shipped by this plugin

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
