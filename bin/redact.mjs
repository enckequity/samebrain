#!/usr/bin/env node
// Redacts secrets from stdin with the shared memory scrub (hooks/hindsight.mjs scrub()) and writes
// the result to stdout. Pipe production shell output through it before it reaches a transcript:
//   kubectl exec deploy/app -- env | node ~/samebrain/bin/redact.mjs
// Prefer reading service URLs from manifests; never `printenv` a pod unfiltered.
import { scrub } from '../hooks/hindsight.mjs';

// --credentials-only (used by hooks/redact-hook.mjs) keeps card-shaped IDs and op:// references.
const credentialsOnly = process.argv.includes('--credentials-only');
process.stdin.setEncoding('utf8');
let text = '';
for await (const chunk of process.stdin) text += chunk;
process.stdout.write(scrub(text, { credentialsOnly }));
