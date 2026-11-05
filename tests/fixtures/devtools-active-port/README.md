# DevToolsActivePort fixtures

Sanitized copies of the file Chrome writes after
`chrome://inspect/#remote-debugging` → tick "Discover network targets" → **Allow**
(see SPEC §5.1). Line 1 is the port, line 2 is the browser path. The UUIDs and
ports are synthetic; no profile path or personal data is embedded.

| File | Shape |
|---|---|
| `valid.txt` | normal Linux file, LF |
| `valid-crlf.txt` | same format with CRLF line endings |
| `blank-lines.txt` | blank lines before/between entries (port 9223) |
| `non-numeric-port.txt` | line 1 is not a port |
| `out-of-range-port.txt` | port 70000 |
| `missing-path.txt` | port only, no browser path |
| `path-without-slash.txt` | path lacks the leading `/` (normalized by the parser) |
| `invalid-path.txt` | browser path contains whitespace |
| `control-char-path.txt` | browser path contains a raw NUL byte (must be skipped) |
