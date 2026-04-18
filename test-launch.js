#!/usr/bin/env node

// Test launching browser via CLI
import { execSync } from 'child_process';

try {
  // Use the CLI to send a launch command with CDP URL
  const result = execSync(
    'node dist/index.js final-test --annotate launch --cdpUrl ws://localhost:9222/devtools/browser/fbffe38b-b2d2-4d2a-a786-ed8c973b02dd',
    { encoding: 'utf-8', timeout: 10000 }
  );

  console.log('Result:', result);
  const response = JSON.parse(result);

  if (response.success) {
    console.log('✓ Browser launched successfully');
  } else {
    console.log('✗ Launch failed:', response.error);
  }
} catch (e) {
  console.error('Error:', e.message);
  if (e.stdout) console.log('Stdout:', e.stdout);
  if (e.stderr) console.log('Stderr:', e.stderr);
}
