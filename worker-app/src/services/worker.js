const si = require('systeminformation');
const { execSync } = require('child_process');

class WorkerService {
  constructor() {
    this.isRunning = false;
    this.stats = {
      cpu_usage: 0,
      ram_usage: 0,
      gpu_usage: 0,
      gpu_vram_used: 0,
      gpu_vram_total: 0,
      disk_usage: 0,
      tasksCompleted: 0,
    };
  }

  async start() {
    this.isRunning = true;
    this.updateStats();
    console.log('⚙️  Resource monitoring started');
  }

  stop() {
    this.isRunning = false;
    console.log('⚙️  Resource monitoring stopped');
  }

  async updateStats() {
    if (!this.isRunning) return;

    try {
      const [load, mem, fsSize] = await Promise.all([
        si.currentLoad(),
        si.mem(),
        si.fsSize(),
      ]);

      this.stats.cpu_usage = Math.round(load.currentLoad * 10) / 10;
      this.stats.ram_usage = Math.round((mem.used / mem.total) * 1000) / 10;

      if (fsSize.length > 0) {
        this.stats.disk_usage = Math.round((fsSize[0].used / fsSize[0].size) * 1000) / 10;
      }

      this.detectGPU();
    } catch (err) {
      console.error('Error updating stats:', err.message);
    }

    setTimeout(() => this.updateStats(), 10000);
  }

  detectGPU() {
    try {
      const output = execSync(
        'nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null',
        { encoding: 'utf8', timeout: 5000 }
      ).trim();

      if (output) {
        const line = output.split('\n')[0];
        const [gpuUtil, memUsed, memTotal] = line.split(',').map(s => parseInt(s.trim(), 10));
        this.stats.gpu_usage = gpuUtil || 0;
        this.stats.gpu_vram_used = memUsed || 0;
        this.stats.gpu_vram_total = memTotal || 0;
      }
    } catch (e) {
      // No NVIDIA GPU or nvidia-smi not available
      this.stats.gpu_usage = 0;
      this.stats.gpu_vram_used = 0;
      this.stats.gpu_vram_total = 0;
    }
  }

  getStats() {
    return this.stats;
  }
}

module.exports = WorkerService;
