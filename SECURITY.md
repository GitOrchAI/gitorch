# Security Policy

## Supported Versions

Only the latest version of GitOrch is supported for security updates.

| Version | Supported |
| --- | --- |
| Active Development | :white_check_mark: |

## Reporting a Vulnerability

If you find a security vulnerability, please report it via the GitHub Private Vulnerability Reporting feature of this repository.

Do not open a public issue for security vulnerabilities.

## Secure File Handling

When handling compressed files (e.g., `.tar`, `.zip`), follow these best practices to prevent directory traversal and arbitrary file read/write vulnerabilities:

1.  **Validate Source:** Ensure the source of the archive is trusted.
2.  **Harden Extraction:** If using the `tar` library, always set `preservePaths: false` and `unlink: true`.
3.  **Reject Hardlinks:** Use the `onentry` hook to inspect entries and throw an error if a hardlink (`entry.type === 'Link'`) is encountered.
4.  **Use Latest Versions:** Keep decompression libraries updated to the latest secure versions.
