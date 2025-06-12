const { Vec3 } = require('vec3');

class BotController {
    constructor(bot) {
        this.bot = bot;
        this.currentPath = [];
        this.currentWaypointIndex = 0;
        this.pathfinding = null;
        this.isNavigating = false;
        this.target = null;
        this.currentTarget = null;
        this.lastPosition = null;
        this.stuckCounter = 0;
        this.maxStuckCount = 30;
        this.waypointRadius = 1.0;
        this.lastPathUpdate = 0;
        this.pathUpdateInterval = 2000;
        this.movementState = {
            forward: false,
            back: false,
            left: false,
            right: false,
            jump: false,
            sprint: false
        };
        this.plannedPath = [];
        this.actualPath = [];
        
        // 优化记忆系统
        this.memoryBlocks = new Map();
        this.lastMemoryUpdate = 0;
        this.memoryUpdateInterval = 2000; // 增加到2秒
        this.perception = null;
        this.maxMemorySize = 5000; // 限制记忆大小

        this.bot.on('physicTick', () => {
            if (this.isNavigating) {
                this.updateNavigation();
            }
            this.updateMemoryData();
        });
        
        this.bot.on('move', () => {
            if (this.isNavigating && this.actualPath.length < 1000) { // 限制轨迹长度
                this.actualPath.push(this.bot.entity.position.clone());
            }
        });

        console.log('BotController初始化完成 (自定义寻路版本)');
    }

    setPerception(perceptionInstance) {
        this.perception = perceptionInstance;
        console.log('感知系统引用已设置');
    }

    setPathfinding(pathfindingInstance) {
        this.pathfinding = pathfindingInstance;
        console.log('自定义路径规划器设置完成');
    }

    updateMemoryData() {
        const now = Date.now();
        if (now - this.lastMemoryUpdate < this.memoryUpdateInterval) {
            return;
        }
        this.lastMemoryUpdate = now;

        if (this.perception) {
            try {
                const visibleBlocks = this.perception.getVisibleBlocksArray();
                
                // 批量处理，避免阻塞
                const batchSize = 50;
                let processedCount = 0;
                
                const processBatch = () => {
                    const endIndex = Math.min(processedCount + batchSize, visibleBlocks.length);
                    
                    for (let i = processedCount; i < endIndex; i++) {
                        const block = visibleBlocks[i];
                        const key = `${block.position.x},${block.position.y},${block.position.z}`;
                        
                        if (!this.memoryBlocks.has(key)) {
                            this.memoryBlocks.set(key, {
                                ...block,
                                firstSeenTime: now,
                                lastSeenTime: now
                            });
                        } else {
                            this.memoryBlocks.get(key).lastSeenTime = now;
                        }
                    }
                    
                    processedCount = endIndex;
                    
                    if (processedCount < visibleBlocks.length) {
                        setTimeout(processBatch, 0); // 异步继续处理
                    }
                };
                
                processBatch();

                // 限制内存大小
                if (this.memoryBlocks.size > this.maxMemorySize) {
                    const entries = Array.from(this.memoryBlocks.entries());
                    entries.sort((a, b) => a[1].lastSeenTime - b[1].lastSeenTime);
                    
                    const toRemove = entries.slice(0, this.memoryBlocks.size - this.maxMemorySize);
                    toRemove.forEach(([key]) => this.memoryBlocks.delete(key));
                }

            } catch (error) {
                console.error('更新记忆数据时出错:', error);
            }
        }
    }

    getMemoryBlocks() {
        return Array.from(this.memoryBlocks.values()).slice(0, 1000); // 限制返回数量
    }

    getMemoryBlocksByType(blockType) {
        return this.getMemoryBlocks().filter(block => block.type === blockType);
    }

    getMemoryStats() {
        const blocks = this.getMemoryBlocks();
        const typeCount = {};
        
        blocks.forEach(block => {
            typeCount[block.type] = (typeCount[block.type] || 0) + 1;
        });

        return {
            totalBlocks: this.memoryBlocks.size,
            displayedBlocks: blocks.length,
            typeCount: typeCount
        };
    }

    findNearestMemoryBlockToTarget(target) {
        // 获取所有记忆方块
        const memoryBlocks = this.getMemoryBlocks();
        let minDist = Infinity;
        let nearest = null;
        for (const block of memoryBlocks) {
            // 可加更多过滤条件，比如 block.type 必须是可行走的地面
            const dist = Math.sqrt(
                Math.pow(block.position.x - target.x, 2) +
                Math.pow(block.position.y - target.y, 2) +
                Math.pow(block.position.z - target.z, 2)
            );
            if (dist < minDist) {
                minDist = dist;
                nearest = block.position;
            }
        }
        return nearest;
    }

    async navigateTo(target) {
        try {
            console.log(`开始自定义导航到: ${target.x}, ${target.y}, ${target.z}`);
            
            this.target = target instanceof Vec3 ? target : new Vec3(target.x, target.y, target.z);
            this.isNavigating = true;
            this.stuckCounter = 0;
            this.currentTarget = this.target;
            
            // 清理旧的轨迹
            this.actualPath = [];
            
            if (this.pathfinding) {
                const path = await this.pathfinding.exploreToTarget(this.target);
                if (path && path.length > 0) {
                    this.plannedPath = path.map(p => p.clone ? p.clone() : {...p});
                    this.currentPath = this.plannedPath.slice();
                    this.currentWaypointIndex = 0;
                    console.log(`路径重规划完成，新路径包含 ${this.currentPath.length} 个点`);
                    // 新增：详细打印路径点
                    this.currentPath.forEach((pt, idx) => {
                        console.log(`  航点${idx}: (${pt.x.toFixed(2)}, ${pt.y.toFixed(2)}, ${pt.z.toFixed(2)})`);
                    });
                    this.bot.chat(`找到路径，包含 ${this.currentPath.length} 个航点`);
                } else {
                    // 新增：在记忆空间中找最近点
                    const nearest = this.findNearestMemoryBlockToTarget(this.target);
                    if (nearest) {
                        console.log('目标不可达，尝试导航到记忆空间中最近的点:', nearest);
                        this.bot.chat('目标不可达，尝试靠近目标');
                        await this.navigateTo(nearest);
                    } else {
                        console.log('路径规划失败');
                        this.bot.chat('无法找到有效路径');
                        this.stopNavigation();
                    }
                }
            } else {
                console.log('路径规划器未可用');
                this.stopNavigation();
            }
            
        } catch (error) {
            console.error('导航失败:', error);
            this.stopNavigation();
            this.bot.chat('导航过程中发生错误');
        }
    }

    updateNavigation() {
        try {
            if (!this.isNavigating || !this.target) {
                return;
            }

            const currentPos = this.bot.entity.position.clone();
            const targetDistance = currentPos.distanceTo(this.target);

            if (targetDistance < this.waypointRadius) {
                console.log('已到达目标位置');
                this.bot.chat('导航完成！');
                this.stopNavigation();
                return;
            }

            

            this.lastPosition = currentPos.clone();
            this.moveTowardWaypoint(currentPos);

            const now = Date.now();
            if (now - this.lastPathUpdate > this.pathUpdateInterval) {
                this.lastPathUpdate = now;
                this.replanPath();
            }

        } catch (error) {
            console.error('导航更新错误:', error);
        }
    }

    moveTowardWaypoint(botPos) {
        try {
            if (this.currentPath.length === 0 || this.currentWaypointIndex >= this.currentPath.length) {
                this.clearMovement();
                return;
            }

            const waypoint = this.currentPath[this.currentWaypointIndex];
            const waypointVec3 = waypoint instanceof Vec3 ? waypoint : new Vec3(waypoint.x, waypoint.y, waypoint.z);
            const waypointDistance = botPos.distanceTo(waypointVec3);

            if (waypointDistance < this.waypointRadius) {
                this.currentWaypointIndex++;
                console.log(`到达航点 ${this.currentWaypointIndex}/${this.currentPath.length}`);
                
                if (this.currentWaypointIndex >= this.currentPath.length) {
                    this.clearMovement();
                }
                return;
            }

            this.calculateMovement(botPos, waypointVec3);

        } catch (error) {
            console.error('移动到航点时出错:', error);
            this.clearMovement();
        }
    }

    calculateMovement(currentPos, targetPos) {
        const dx = targetPos.x - currentPos.x;
        const dz = targetPos.z - currentPos.z;
        const dy = targetPos.y - currentPos.y;
        
        const targetYaw = Math.atan2(-dx, -dz);
        const currentYaw = this.bot.entity.yaw;
        
        let yawDiff = targetYaw - currentYaw;
        
        while (yawDiff > Math.PI) yawDiff -= 2 * Math.PI;
        while (yawDiff < -Math.PI) yawDiff += 2 * Math.PI;
        
        this.clearMovement();
        
        const turnThreshold = 0.1;
        if (Math.abs(yawDiff) > turnThreshold) {
            if (yawDiff > 0) {
                this.setControl('left', true);
            } else {
                this.setControl('right', true);
            }
        } else {
            this.setControl('forward', true);
            
            if (dy > 0.5) {
                this.setControl('jump', true);
            }
        }
        
        this.bot.look(targetYaw, 0, true);
    }

    setControl(control, state) {
        if (this.movementState[control] !== state) {
            this.movementState[control] = state;
            this.bot.setControlState(control, state);
        }
    }

    clearMovement() {
        Object.keys(this.movementState).forEach(control => {
            this.setControl(control, false);
        });
    }

    async replanPath() {
        try {
            if (!this.pathfinding || !this.target) return;

            const currentPos = this.bot.entity.position.clone();
            console.log('重新规划路径...');
            
            // 适配新版API
            const newPath = await this.pathfinding.exploreToTarget(this.target);
            
            if (newPath && newPath.length > 0) {
                this.currentPath = newPath.map(pos => new Vec3(pos.x, pos.y, pos.z));
                this.currentWaypointIndex = 0;
                console.log(`路径重规划完成，新路径包含 ${this.currentPath.length} 个点`);
                this.bot.chat(`找到路径，包含 ${this.currentPath.length} 个航点`);
            } else {
                console.log('路径规划失败');
                this.bot.chat('无法找到有效路径');
                this.stopNavigation();
            }
        } catch (error) {
            console.error('重规划路径时出错:', error);
        }
    }

    isStuck(currentPos) {
        if (!this.lastPosition) {
            return false;
        }

        const moveDistance = currentPos.distanceTo(this.lastPosition);
        
        if (moveDistance < 0.05) {
            this.stuckCounter++;
        } else {
            this.stuckCounter = 0;
        }

        return this.stuckCounter > this.maxStuckCount;
    }

    handleStuck() {
        console.log('检测到卡住，尝试处理...');
        this.bot.chat('检测到卡住，尝试跳跃...');
        
        this.clearMovement();
        
        this.setControl('jump', true);
        const randomTurn = Math.random() > 0.5 ? 'left' : 'right';
        this.setControl(randomTurn, true);
        
        setTimeout(() => {
            this.clearMovement();
        }, 1000);

        this.stuckCounter = 0;

        setTimeout(() => {
            this.replanPath();
        }, 1500);
    }

    stop() {
        this.stopNavigation();
    }

    stopNavigation() {
        console.log('停止导航');
        this.isNavigating = false;
        this.target = null;
        this.currentTarget = null;
        this.currentPath = [];
        this.currentWaypointIndex = 0;
        this.stuckCounter = 0;
        
        this.clearMovement();
        
        console.log('导航已停止');
    }

    getStatus() {
        const memoryStats = this.getMemoryStats();
        return {
            isNavigating: this.isNavigating,
            target: this.target ? {
                x: this.target.x,
                y: this.target.y,
                z: this.target.z
            } : null,
            currentWaypoint: this.currentWaypointIndex,
            totalWaypoints: this.currentPath.length,
            position: this.bot.entity.position ? {
                x: this.bot.entity.position.x,
                y: this.bot.entity.position.y,
                z: this.bot.entity.position.z
            } : null,
            yaw: this.bot.entity.yaw || 0,
            memoryStats: memoryStats
        };
    }

    getPathInfo() {
        return {
            plannedPath: this.plannedPath.slice(0, 200), // 限制路径点数量
            actualPath: this.actualPath.slice(-200), // 只保留最近200个点
            memoryBlocks: this.getMemoryBlocks()
        };
    }

    createViewerInfoWindow() {
        const infoHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Minecraft Viewer 信息</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    margin: 0;
                    padding: 20px;
                    color: white;
                }
                .container {
                    max-width: 600px;
                    margin: 0 auto;
                    background: rgba(255,255,255,0.1);
                    padding: 30px;
                    border-radius: 15px;
                    box-shadow: 0 8px 32px rgba(0,0,0,0.1);
                    backdrop-filter: blur(10px);
                    border: 1px solid rgba(255,255,255,0.2);
                }
                h1 {
                    text-align: center;
                    margin-bottom: 30px;
                    color: #4CAF50;
                    text-shadow: 0 2px 4px rgba(0,0,0,0.3);
                }
                .info-card {
                    background: rgba(255,255,255,0.15);
                    padding: 20px;
                    border-radius: 10px;
                    margin: 15px 0;
                    border-left: 4px solid #4CAF50;
                }
                .status {
                    display: flex;
                    align-items: center;
                    margin-bottom: 10px;
                }
                .status-indicator {
                    width: 12px;
                    height: 12px;
                    background: #4CAF50;
                    border-radius: 50%;
                    margin-right: 10px;
                    animation: pulse 2s infinite;
                }
                @keyframes pulse {
                    0% { opacity: 1; }
                    50% { opacity: 0.5; }
                    100% { opacity: 1; }
                }
                .link {
                    color: #FFD700;
                    text-decoration: none;
                    font-weight: bold;
                    font-size: 18px;
                }
                .link:hover {
                    color: #FFF700;
                }
                .description {
                    margin-top: 15px;
                    line-height: 1.6;
                    opacity: 0.9;
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🎮 Minecraft 可视化服务</h1>
                
                <div class="info-card">
                    <div class="status">
                        <div class="status-indicator"></div>
                        <strong>Prismarine Viewer 已启动</strong>
                    </div>
                    <a href="http://localhost:3007" target="_blank" class="link">
                        🔗 http://localhost:3007
                    </a>
                    <div class="description">
                        Prismarine viewer web server running on *:3007
                    </div>
                </div>

                <div class="info-card">
                    <div class="status">
                        <div class="status-indicator"></div>
                        <strong>控制面板已启动</strong>
                    </div>
                    <a href="http://localhost:3009" target="_blank" class="link">
                        🔗 http://localhost:3009
                    </a>
                    <div class="description">
                        Agent 控制和可视化界面
                    </div>
                </div>
            </div>
        </body>
        </html>
        `;
        
        const fs = require('fs');
        const path = require('path');
        const { exec } = require('child_process');
        
        const tempHtmlPath = path.join(__dirname, 'viewer_info.html');
        fs.writeFileSync(tempHtmlPath, infoHtml);
        
        const platform = require('os').platform();
        let command;
        
        if (platform === 'win32') {
            command = `start ${tempHtmlPath}`;
        } else if (platform === 'darwin') {
            command = `open ${tempHtmlPath}`;
        } else {
            command = `xdg-open ${tempHtmlPath}`;
        }
        
        exec(command, (error) => {
            if (error) {
                console.log('无法自动打开浏览器，请手动访问以下链接:');
                console.log('Minecraft可视化: http://localhost:3007');
                console.log('控制面板: http://localhost:3009');
            }
        });
    }
}

module.exports = BotController;
