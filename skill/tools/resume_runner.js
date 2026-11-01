// resume_runner.js <sessionID> <instructionFile> <logFile> <opencodeExe>
// Detached resume: reads UTF-8 instruction file, spawns
//   opencode run -s <id> --continue --agent build --auto "<instruction>"
// with output appended to logFile. Run detached by watchdog.ps1.
'use strict';
const cp = require('child_process');
const fs = require('fs');

const [, , sessionID, instrFile, logFile, ocExe] = process.argv;
if (!sessionID || !instrFile || !logFile || !ocExe) {
  console.error('usage: resume_runner.js <sessionID> <instructionFile> <logFile> <opencodeExe>');
  process.exit(2);
}

const instr = fs.readFileSync(instrFile, 'utf8');
const out = fs.openSync(logFile, 'a');
fs.writeSync(out, `\n[resume ${new Date().toISOString()}] session=${sessionID}\n`);

const r = cp.spawnSync(ocExe,
  ['run', '-s', sessionID, '--continue', '--agent', 'build', '--auto', instr],
  { stdio: ['ignore', out, out] });

fs.writeSync(out, `[resume exit rc=${r.status} err=${r.error ? r.error.message : 'none'}] session=${sessionID}\n`);
fs.closeSync(out);
