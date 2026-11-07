import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';

// Nhóm nhỏ chỉ dùng cho lượt đầu lớn; mỗi tệp vẫn được xử lý tuần tự bởi Scanner.
export class ScanWorkers {
  constructor(roots, count = Math.min(4, Math.max(1, availableParallelism() - 2))) {
    this.queue = [];
    this.slots = Array.from({ length: count }, () => {
      const worker = new Worker(new URL('./scanner-worker.mjs', import.meta.url), { workerData: roots });
      const slot = { worker, job: null };
      worker.on('message', message => {
        const job = slot.job;
        slot.job = null;
        if (message.error) job.reject(new Error('Không đọc được tệp trong luồng quét.'));
        else job.resolve(message);
        this.dispatch(slot);
      });
      worker.on('error', () => this.fail(slot));
      worker.on('exit', () => this.fail(slot));
      return slot;
    });
  }
  fail(slot) {
    slot.failed = true;
    slot.job?.reject(new Error('Luồng quét đã dừng.'));
    slot.job = null;
    if (this.slots.every(item => item.failed)) {
      for (const job of this.queue.splice(0)) job.reject(new Error('Các luồng quét đã dừng.'));
    }
  }
  dispatch(slot) {
    if (slot.job || slot.failed || !this.queue.length) return;
    slot.job = this.queue.shift();
    slot.worker.postMessage({ entry: slot.job.entry, size: slot.job.size });
  }
  read(entry, size) {
    const result = new Promise((resolve, reject) => this.queue.push({ entry, size, resolve, reject }));
    // Các tệp có thể hoàn tất trước khi vòng chính chờ đến chúng.
    result.catch(() => {});
    for (const slot of this.slots) this.dispatch(slot);
    return result;
  }
  async stop() {
    await Promise.all(this.slots.map(slot => slot.worker.terminate()));
  }
}
