# Token Optimizer Session Memory

<type>file</type>
101:   // Extract file list between <entries> tags if present
181:  * For very large source-file reads, keep the structural outline and important
189:   const codeLines = allLines.filter(line => !/^<\/?path>/.test(line.trim()))
201:     if (/^\s*(import|export|from|package|using|namespace)\b/.test(line)) keep(i)
202:     if (/^\s*(export\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var)\s+[A-Za-z0-9_$]+/.test(line)) keep(i)
203:     if (/^\s*(public|private|protected|static|async)\s+[\w$]+\s*\(/.test(line)) keep(i)
204:     if (/\b(TODO|FIXME|HACK|throw new|console\.error|error|failed|deprecated)\b/i.test(line)) keep(i)
216:     "[request a narrower line range or full/raw detail for exact file contents]",
228:   if (rawOutput.startsWith("The file was created successfully")) {
229:     return "created"
1097:     if (sub === "build") {
1098:       // Docker build: keep only step headers, errors, and the final summary
1101:         /^Step\s+\d+/i.test(l) ||
1102:         /^(ERROR|error|Successfully built|Successfully tagged|\[Error\])/i.test(l) ||
1103:         /---> (Running|Using cache)/.test(l) ||
1104:         /^Removing intermediate/.test(l)
 *   npm/yarn/pnpm test         → 85-90%
 *   cargo test / pytest        → 88-92%
