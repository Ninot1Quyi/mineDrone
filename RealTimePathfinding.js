const { Vec3 } = require('vec3');

class AdaptiveExplorer {
    constructor(bot, perception) {
        this.bot = bot;
        this.perception = perception;
        
        // 核心参数
        this.viewRadius = 16;
        this.stepSize = 2.0;
        this.goalRadius = 1.0;
        this.maxJumpHeight = 1.2;
        this.maxFallHeight = 4.0;
        
        // 动态导航状态
        this.finalTarget = null;
        this.plannedPath = [];
        this.pathIndex = 0;
        this.stuckCounter = 0;
        this.maxStuckCount = 3;
        
        // 3D空间知识地图
        this.voxelMap = new Map();
        this.occupancyGrid = new Map();
        this.surfaceMap = new Map();
        this.explorationFrontier = new Set();
        this.safeAirSpaces = new Set();
        
        // 空间分析参数
        this.voxelSize = 1.0;
        this.explorationRadius = 32;
        this.confidenceDecay = 0.98;
        this.minConfidence = 0.4;
        
        // 重规划参数
        this.replanThreshold = 2.0;
        this.replanInterval = 1000;
        this.lastReplanTime = 0;
        
        // 卡住检测
        this.lastPositionLog = [];
        this.positionLogSize = 5;
        this.stuckPositions = new Set();
        
        // 统计信息
        this.stats = {
            exploredVoxels: 0,
            pathsPlanned: 0,
            successfulMoves: 0,
            escapeAttempts: 0,
            frontierPoints: 0
        };
        
        console.log("AdaptiveExplorer 初始化完成 - 简化避水导航");
    }

    // 🔥 简化的方块分析 - 重点处理水
    analyze3DBlock(block) {
        const blockType = block.type.toLowerCase();
        
        // 🚫 水 = 固体障碍物（简单粗暴）
        const isWater = blockType.includes('water');
        
        // 明确的空气方块
        const isAir = ['air', 'void_air', 'cave_air'].includes(blockType);
        
        // 危险方块
        const isDangerous = blockType.includes('lava') || 
                           blockType.includes('fire') ||
                           blockType.includes('cactus');
        
        // 🔑 关键逻辑：水 = 固体 = 不可通行
        let isSolid, isPassable;
        if (isWater) {
            isSolid = true;         // 水当作固体
            isPassable = false;     // 水不可通行
        } else if (isAir) {
            isSolid = false;
            isPassable = true;
        } else {
            // 根据已知的固体方块判断
            const knownSolids = [
                'stone', 'dirt', 'grass_block', 'cobblestone', 'sand', 'gravel',
                'oak_log', 'oak_planks', 'oak_leaves', 'birch_log', 'spruce_log',
                'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore'
            ];
            isSolid = knownSolids.includes(blockType);
            isPassable = !isSolid && !isDangerous;
        }
        
        return {
            type: block.type,
            isAir: isAir,
            isSolid: isSolid,
            isWater: isWater,
            isDangerous: isDangerous,
            isPassable: isPassable,
            supportWeight: isSolid && !isDangerous,
            analysis: `${blockType} -> Air:${isAir} Solid:${isSolid} Water:${isWater} Passable:${isPassable}`
        };
    }

    // 主入口
    async exploreToTarget(targetPos) {
        const currentPos = this.bot.entity.position;
        
        console.log(`\n=== 3D空间导航开始 ===`);
        console.log(`当前位置: (${currentPos.x.toFixed(1)}, ${currentPos.y.toFixed(1)}, ${currentPos.z.toFixed(1)})`);
        console.log(`目标位置: (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`);
        
        // 🏊‍♂️ 如果在水中，优先上岸
        if (this.isCurrentlyInWater()) {
            console.log('🚨 检测到在水中，紧急上岸！');
            return await this.emergencyExitWater(currentPos);
        }
        
        // 记录位置历史
        this.recordPosition(currentPos);
        
        // 更新3D空间知识地图
        this.update3DKnowledgeMap();
        
        // 检查是否需要设置新目标
        if (!this.finalTarget || this.distance3D(targetPos, this.finalTarget) > 3.0) {
            this.finalTarget = this.cloneVector(targetPos);
            this.plannedPath = [];
            this.pathIndex = 0;
            console.log('设置新的3D导航目标');
        }
        
        // 检查是否卡住
        if (this.isReallyStuck()) {
            console.log('检测到卡住，执行逃脱');
            return await this.executeEscapeManeuver(currentPos);
        }
        
        // 检查是否需要重规划
        if (this.needsReplanning(currentPos)) {
            console.log('触发路径重规划');
            await this.replan3DPath(currentPos);
        }
        
        // 获取下一步移动
        const nextStep = await this.getNext3DStep(currentPos);
        if (nextStep) {
            // 🔍 再次检查下一步是否安全（不是水）
            if (this.isWaterPosition(nextStep)) {
                console.log('❌ 下一步是水，寻找陆地替代');
                return await this.findDryLandPath(currentPos, targetPos);
            }
            
            console.log(`✅ 下一步移动: (${nextStep.x.toFixed(1)}, ${nextStep.y.toFixed(1)}, ${nextStep.z.toFixed(1)})`);
            return [currentPos, nextStep];
        }
        
        // 最后手段：寻找干燥陆地
        console.log('常规路径失败，寻找干燥陆地');
        return await this.findDryLandPath(currentPos, targetPos);
    }

    // 🏊‍♂️ 检查当前是否在水中
    isCurrentlyInWater() {
        const currentPos = this.bot.entity.position;
        
        // 检查脚下、身体、头部是否有水
        const positions = [
            currentPos,
            { x: currentPos.x, y: currentPos.y - 0.5, z: currentPos.z },
            { x: currentPos.x, y: currentPos.y + 0.5, z: currentPos.z }
        ];
        
        for (const pos of positions) {
            if (this.isWaterPosition(pos)) {
                return true;
            }
        }
        
        return false;
    }

    // 🌊 检查位置是否为水
    isWaterPosition(position) {
        const voxel = this.getVoxelInfo(position);
        return voxel && voxel.analysis.isWater;
    }

    // 🏖️ 紧急离开水域
    async emergencyExitWater(currentPos) {
        console.log('🏊‍♂️ 执行紧急离水！');
        
        // 寻找最近的干燥陆地
        const dryLand = this.findNearestDryLand(currentPos);
        if (dryLand) {
            console.log(`🏃‍♂️ 找到陆地: (${dryLand.x.toFixed(1)}, ${dryLand.y.toFixed(1)}, ${dryLand.z.toFixed(1)})`);
            return [currentPos, dryLand];
        }
        
        // 如果找不到陆地，向任意非水方向移动
        const escapeDirection = this.findNonWaterDirection(currentPos);
        if (escapeDirection) {
            return [currentPos, escapeDirection];
        }
        
        // 最后手段：向上游泳到水面
        const surfaceTarget = {
            x: currentPos.x,
            y: currentPos.y + 3,
            z: currentPos.z
        };
        console.log('🏊‍♂️ 向水面游泳');
        return [currentPos, surfaceTarget];
    }

    // 🔍 寻找最近的干燥陆地
    findNearestDryLand(currentPos) {
        let nearestDryLand = null;
        let nearestDistance = Infinity;
        
        // 从安全空气空间中找干燥陆地
        for (const airKey of this.safeAirSpaces) {
            const airPos = this.parseVoxelKey(airKey);
            if (!airPos) continue;
            
            // 检查这个空气位置下面是否有支撑且不是水
            const groundPos = { x: airPos.x, y: airPos.y - 1, z: airPos.z };
            const groundVoxel = this.getVoxelInfo(groundPos);
            
            if (groundVoxel && 
                groundVoxel.analysis.supportWeight && 
                !groundVoxel.analysis.isWater &&
                !this.isWaterPosition(airPos)) {
                
                const distance = this.distance3D(currentPos, airPos);
                if (distance < nearestDistance && distance > 1) {
                    nearestDistance = distance;
                    nearestDryLand = airPos;
                }
            }
        }
        
        return nearestDryLand;
    }

    // 🧭 寻找非水方向
    findNonWaterDirection(currentPos) {
        // 尝试8个方向
        const directions = [
            { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 },
            { x: 1, z: 1 }, { x: -1, z: 1 }, { x: 1, z: -1 }, { x: -1, z: -1 }
        ];
        
        for (const dir of directions) {
            for (let distance = 2; distance <= 5; distance++) {
                const candidate = {
                    x: currentPos.x + dir.x * distance,
                    y: currentPos.y,
                    z: currentPos.z + dir.z * distance
                };
                
                if (!this.isWaterPosition(candidate)) {
                    return candidate;
                }
            }
        }
        
        return null;
    }

    // 🗺️ 寻找干燥陆地路径
    async findDryLandPath(currentPos, targetPos) {
        console.log('🗺️ 规划避水路径');
        
        // 寻找不含水的中间点
        const direction = this.getDirection3D(currentPos, targetPos);
        
        // 尝试不同的路径点
        for (let angle = 0; angle < 360; angle += 45) {
            for (let distance = 3; distance <= 8; distance++) {
                const rad = (angle * Math.PI) / 180;
                const candidate = {
                    x: currentPos.x + Math.cos(rad) * distance,
                    y: currentPos.y,
                    z: currentPos.z + Math.sin(rad) * distance
                };
                
                if (this.isDryLandPosition(candidate)) {
                    console.log(`找到干燥路径点: (${candidate.x.toFixed(1)}, ${candidate.y.toFixed(1)}, ${candidate.z.toFixed(1)})`);
                    return [currentPos, candidate];
                }
            }
        }
        
        // 如果还是找不到，朝目标方向但增加高度避免水域
        const safeTarget = {
            x: currentPos.x + direction.x * 3,
            y: currentPos.y + 2, // 增加高度
            z: currentPos.z + direction.z * 3
        };
        
        console.log(`使用高度避水: (${safeTarget.x.toFixed(1)}, ${safeTarget.y.toFixed(1)}, ${safeTarget.z.toFixed(1)})`);
        return [currentPos, safeTarget];
    }

    // 🏞️ 检查是否为干燥陆地位置
    isDryLandPosition(position) {
        const voxel = this.getVoxelInfo(position);
        const groundVoxel = this.getVoxelInfo({ x: position.x, y: position.y - 1, z: position.z });
        
        // 身体位置必须不是水且可通行
        if (voxel && (voxel.analysis.isWater || !voxel.analysis.isPassable)) {
            return false;
        }
        
        // 脚下必须有支撑且不是水
        if (groundVoxel && groundVoxel.analysis.supportWeight && !groundVoxel.analysis.isWater) {
            return true;
        }
        
        return false;
    }

    // 更新3D空间知识地图
    update3DKnowledgeMap() {
        if (!this.perception || typeof this.perception.getMemoryBlocksArray !== 'function') {
            console.log('感知系统不可用');
            return;
        }
        
        const memoryBlocks = this.perception.getMemoryBlocksArray();
        const currentTime = Date.now();
        const botPos = this.bot.entity.position;
        
        console.log(`\n--- 3D空间建模更新 ---`);
        console.log(`感知到 ${memoryBlocks.length} 个体素`);
        
        let newVoxels = 0;
        let updatedVoxels = 0;
        let airVoxels = 0;
        let solidVoxels = 0;
        let waterVoxels = 0;
        let passableVoxels = 0;
        
        // 处理每个方块
        for (const block of memoryBlocks) {
            const voxelKey = this.getVoxelKey(block.position);
            const distance = this.distance3D(block.position, botPos);
            const confidence = Math.max(0.6, 1.0 - (distance / this.viewRadius));
            
            // 使用简化的方块分析
            const blockAnalysis = this.analyze3DBlock(block);
            
            // 调试输出
            if (newVoxels + updatedVoxels < 3) {
                console.log(`方块分析: ${blockAnalysis.analysis}`);
            }
            
            const existingVoxel = this.voxelMap.get(voxelKey);
            if (existingVoxel) {
                updatedVoxels++;
                existingVoxel.analysis = blockAnalysis;
                existingVoxel.confidence = confidence;
                existingVoxel.lastSeen = currentTime;
            } else {
                newVoxels++;
                this.voxelMap.set(voxelKey, {
                    position: this.cloneVector(block.position),
                    block: block,
                    confidence: confidence,
                    firstSeen: currentTime,
                    lastSeen: currentTime,
                    analysis: blockAnalysis
                });
            }
            
            // 更新空间分类
            this.updateSpaceClassification(voxelKey, blockAnalysis);
            
            // 统计
            if (blockAnalysis.isAir) airVoxels++;
            if (blockAnalysis.isSolid) solidVoxels++;
            if (blockAnalysis.isWater) waterVoxels++;
            if (blockAnalysis.isPassable) passableVoxels++;
        }
        
        console.log(`体素统计:`);
        console.log(`  新增: ${newVoxels}, 更新: ${updatedVoxels}`);
        console.log(`  空气: ${airVoxels}, 固体: ${solidVoxels}, 水: ${waterVoxels}`);
        console.log(`  可通行: ${passableVoxels}, 安全空气: ${this.safeAirSpaces.size}`);
    }

    // 更新空间分类
    updateSpaceClassification(voxelKey, analysis) {
        // 只有非水的空气才是安全的
        if (analysis.isAir && !analysis.isWater) {
            this.safeAirSpaces.add(voxelKey);
        } else {
            this.safeAirSpaces.delete(voxelKey);
        }
    }

    // 记录位置历史
    recordPosition(position) {
        this.lastPositionLog.push({
            position: this.cloneVector(position),
            timestamp: Date.now()
        });
        
        if (this.lastPositionLog.length > this.positionLogSize) {
            this.lastPositionLog.shift();
        }
    }

    // 卡住检测
    isReallyStuck() {
        if (this.lastPositionLog.length < 3) return false;
        
        const recent = this.lastPositionLog.slice(-3);
        let totalMovement = 0;
        
        for (let i = 1; i < recent.length; i++) {
            const movement = this.distance3D(recent[i-1].position, recent[i].position);
            totalMovement += movement;
        }
        
        const avgMovement = totalMovement / (recent.length - 1);
        return avgMovement < 0.3;
    }

    // 逃脱机制
    async executeEscapeManeuver(currentPos) {
        console.log('执行避水逃脱机制');
        this.stats.escapeAttempts++;
        
        // 寻找干燥的逃脱路径
        for (let angle = 0; angle < 360; angle += 60) {
            for (let distance = 2; distance <= 5; distance++) {
                const rad = (angle * Math.PI) / 180;
                const candidate = {
                    x: currentPos.x + Math.cos(rad) * distance,
                    y: currentPos.y + 1, // 稍微增加高度
                    z: currentPos.z + Math.sin(rad) * distance
                };
                
                if (this.isDryLandPosition(candidate)) {
                    console.log(`找到逃脱路径: (${candidate.x.toFixed(1)}, ${candidate.y.toFixed(1)}, ${candidate.z.toFixed(1)})`);
                    
                    // 清除路径重新规划
                    this.plannedPath = [];
                    this.pathIndex = 0;
                    
                    return [currentPos, candidate];
                }
            }
        }
        
        // 如果找不到，向上移动
        const upTarget = {
            x: currentPos.x,
            y: currentPos.y + 2,
            z: currentPos.z
        };
        
        console.log('向上逃脱');
        return [currentPos, upTarget];
    }

    // 重规划检查
    needsReplanning(currentPos) {
        const now = Date.now();
        
        if (now - this.lastReplanTime < this.replanInterval) {
            return false;
        }
        
        if (this.plannedPath.length === 0 || this.pathIndex >= this.plannedPath.length) {
            return true;
        }
        
        // 检查当前目标是否安全（不是水）
        if (this.pathIndex < this.plannedPath.length) {
            const currentTarget = this.plannedPath[this.pathIndex];
            if (this.isWaterPosition(currentTarget)) {
                console.log('当前航点在水中，需要重规划');
                return true;
            }
        }
        
        return false;
    }

    // 路径重规划
    async replan3DPath(currentPos) {
        console.log('开始避水路径重规划');
        this.lastReplanTime = Date.now();
        this.plannedPath = [];
        this.pathIndex = 0;
        this.stats.pathsPlanned++;
        
        // 简单的避水路径规划
        const direction = this.getDirection3D(currentPos, this.finalTarget);
        const stepDistance = 3;
        const maxSteps = 4;
        
        this.plannedPath = [currentPos];
        
        for (let i = 1; i <= maxSteps; i++) {
            let stepPos = {
                x: currentPos.x + direction.x * stepDistance * i,
                y: currentPos.y + 0.5, // 稍微高一点避免水
                z: currentPos.z + direction.z * stepDistance * i
            };
            
            // 如果这个点在水中，尝试调整
            let attempts = 0;
            while (this.isWaterPosition(stepPos) && attempts < 8) {
                const angle = (attempts * 45) * Math.PI / 180;
                stepPos = {
                    x: currentPos.x + direction.x * stepDistance * i + Math.cos(angle) * 2,
                    y: currentPos.y + 1,
                    z: currentPos.z + direction.z * stepDistance * i + Math.sin(angle) * 2
                };
                attempts++;
            }
            
            this.plannedPath.push(stepPos);
        }
        
        this.pathIndex = 1;
        console.log(`避水路径规划完成: ${this.plannedPath.length} 个节点`);
    }

    // 获取下一步
    async getNext3DStep(currentPos) {
        if (this.plannedPath.length > 0 && this.pathIndex < this.plannedPath.length) {
            const nextWaypoint = this.plannedPath[this.pathIndex];
            const distance = this.distance3D(currentPos, nextWaypoint);
            
            if (distance < this.goalRadius) {
                this.pathIndex++;
                if (this.pathIndex < this.plannedPath.length) {
                    return this.plannedPath[this.pathIndex];
                }
                return null;
            }
            
            return nextWaypoint;
        }
        
        return null;
    }
    
    // 基础方法
    distance3D(pos1, pos2) {
        const dx = pos1.x - pos2.x;
        const dy = pos1.y - pos2.y;
        const dz = pos1.z - pos2.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    getDirection3D(from, to) {
        const direction = {
            x: to.x - from.x,
            y: to.y - from.y,
            z: to.z - from.z
        };
        
        const length = Math.sqrt(direction.x ** 2 + direction.y ** 2 + direction.z ** 2);
        if (length === 0) return { x: 0, y: 0, z: 0 };
        
        return {
            x: direction.x / length,
            y: direction.y / length,
            z: direction.z / length
        };
    }

    getVoxelKey(position) {
        return `${Math.floor(position.x / this.voxelSize)},${Math.floor(position.y / this.voxelSize)},${Math.floor(position.z / this.voxelSize)}`;
    }

    parseVoxelKey(key) {
        const parts = key.split(',');
        if (parts.length !== 3) return null;
        return {
            x: parseInt(parts[0]) * this.voxelSize + this.voxelSize / 2,
            y: parseInt(parts[1]) * this.voxelSize + this.voxelSize / 2,
            z: parseInt(parts[2]) * this.voxelSize + this.voxelSize / 2
        };
    }

    cloneVector(vec) {
        return { x: vec.x, y: vec.y, z: vec.z };
    }

    getVoxelInfo(position) {
        const key = this.getVoxelKey(position);
        return this.voxelMap.get(key);
    }
}

module.exports = AdaptiveExplorer;
