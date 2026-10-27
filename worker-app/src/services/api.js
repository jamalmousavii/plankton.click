const axios = require('axios');

class ApiService {
  constructor() {
    this.baseUrl = 'https://plankton.click/api';
  }

  async register(workerToken, gpu, ram, cpu, models) {
    const response = await axios.post(`${this.baseUrl}/workers/setup`, {
      worker_token: workerToken,
      gpu_model: gpu,
      ram: ram,
      cpu: cpu,
      models: models,
    });
    return response.data;
  }

  async heartbeat(workerId, data) {
    const response = await axios.put(`${this.baseUrl}/workers/${workerId}/heartbeat`, data);
    return response.data;
  }
}

module.exports = ApiService;
