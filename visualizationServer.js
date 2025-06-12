const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

class VisualizationServer {
  constructor(bot, perception, controller, port = 3008) {
    this.bot = bot;
    this.perception = perception;
    this.controller = controller;
    this.port = port;
    this.clients = new Set();
    this.updateInterval = null;
    
    this.setupServer();
    this.setupHTTPServer();
    this.startUpdating();
  }

  setupServer() {
    this.wss = new WebSocket.Server({ port: this.port });
    
    this.wss.on('connection', (ws) => {
      console.log('可视化客户端已连接');
      this.clients.add(ws);
      
      // 立即发送当前状态
      this.sendAgentState(ws);
      
      ws.on('message', (message) => {
        try {
          const data = JSON.parse(message);
          console.log('收到消息', data);
          let handled = false;
          if (data.type === 'getMemory' || data.type === 'requestMemory') {
            // 新增：推送memoryMap内容
            if (this.perception && typeof this.perception.getMemoryBlocksArray === 'function') {
              console.log('发送memory，数量:', this.perception.getMemoryBlocksArray().length);
              ws.send(JSON.stringify({ type: 'memoryBlocks', blocks: this.perception.getMemoryBlocksArray() }));
            }
            handled = true;
          }
          if (data.type === 'setViewDistance' && typeof data.value === 'number') {
            if (this.perception && typeof this.perception.adjustScanParameters === 'function') {
              this.perception.adjustScanParameters({ scanRadius: data.value });
              // 立即异步感知一次，并在完成后推送新状态
              if (typeof this.perception.updatePerceptionAsync === 'function') {
                this.perception.updatePerceptionAsync().then(() => {
                  this.broadcastAgentState();
                });
              } else {
                this.broadcastAgentState();
              }
            }
            handled = true;
          }
          if (!handled) {
            this.handleClientMessage(data, ws);
          }
        } catch (error) {
          console.error('处理客户端消息失败:', error);
        }
      });
      
      ws.on('close', () => {
        console.log('可视化客户端已断开');
        this.clients.delete(ws);
      });
      
      ws.on('error', (error) => {
        console.error('WebSocket客户端错误:', error);
        this.clients.delete(ws);
      });
    });
    
    console.log(`可视化WebSocket服务器运行在端口 ${this.port}`);
  }

  setupHTTPServer() {
    const httpPort = this.port + 1; // HTTP服务器端口
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/visualization.html') {
        const htmlPath = path.join(__dirname, 'visualization.html');
        fs.readFile(htmlPath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('页面未找到');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        });
      } else {
        res.writeHead(404);
        res.end('页面未找到');
      }
    });
    
    server.listen(httpPort, () => {
      console.log(`可视化HTTP服务器运行在 http://localhost:${httpPort}`);
    });
  }

  handleClientMessage(data, ws) {
    switch (data.type) {
      case 'command':
        this.handleCommand(data, ws);
        break;
      default:
        console.log('未知消息类型:', data.type);
    }
  }

  handleCommand(data, ws) {
    switch (data.command) {
      case 'navigate':
        if (data.target) {
          this.controller.navigateTo(data.target);
          this.bot.chat(`通过可视化界面导航到 ${data.target.x}, ${data.target.y}, ${data.target.z}`);
        }
        break;
      case 'stop':
        this.controller.stop();
        this.bot.chat('通过可视化界面停止导航');
        break;
      case 'status':
        this.sendAgentState(ws);
        break;
    }
  }

  startUpdating() {
    // 每500ms更新一次数据
    this.updateInterval = setInterval(() => {
      if (this.clients.size > 0) {
        this.broadcastAgentState();
      }
    }, 500);
  }

  sendAgentState(ws) {
    const agentState = this.getAgentState();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'agentState',
        ...agentState
      }));
    }
  }

  broadcastAgentState() {
    const agentState = this.getAgentState();
    const message = JSON.stringify({
      type: 'agentState',
      ...agentState
    });
    
    this.clients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }

  getAgentState() {
    const position = this.bot.entity.position;
    const yaw = this.bot.entity.yaw;
    
    // 获取可见方块
    let visibleBlocks = [];
    if (this.perception) {
      visibleBlocks = this.perception.updatePerception();
    }
    
    // 获取目标位置
    let target = null;
    if (this.controller.currentTarget) {
      target = {
        x: this.controller.currentTarget.x,
        y: this.controller.currentTarget.y,
        z: this.controller.currentTarget.z
      };
    }
    
    let plannedPath = [];
    let actualPath = [];
    if (this.controller && typeof this.controller.getPathInfo === 'function') {
      const info = this.controller.getPathInfo();
      plannedPath = info.plannedPath || [];
      actualPath = info.actualPath || [];
    }
    
    return {
      position: {
        x: position.x,
        y: position.y,
        z: position.z
      },
      yaw: yaw,
      target: target,
      visibleBlocks: visibleBlocks,
      isNavigating: this.controller.isNavigating || false,
      plannedPath: plannedPath,
      actualPath: actualPath
    };
  }

  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    if (this.wss) {
      this.wss.close();
    }
    
    console.log('可视化服务器已停止');
  }
}

module.exports = VisualizationServer;
