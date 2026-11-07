import { parentPort, workerData } from 'node:worker_threads';
import { Scanner } from './scanner.mjs';

const scanner = new Scanner(workerData);
parentPort.on('message', async ({ entry, size }) => {
  scanner.scan.bytesRead = 0;
  scanner.scan.invalidLines = 0;
  scanner.warnings.clear();
  try {
    await scanner.readAppend(entry, size);
    scanner.finishPrompts(entry);
    parentPort.postMessage({ entry, bytesRead: scanner.scan.bytesRead,
      invalidLines: scanner.scan.invalidLines, warnings: [...scanner.warnings] });
  } catch { parentPort.postMessage({ error: true }); }
});
