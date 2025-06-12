const { Vec3 } = require('vec3');

class AdaptiveExplorer {
    constructor(bot, perception) {
        this.bot = bot;
        this.perception = perception;
        
        // 核心参数
        this.viewRadius = 16;
        this.stepSize = 1.5;
        this.goalRadius = 1.5;
        this.maxJumpHeight = 1.0;
        this.maxFallHeight = 3.0;
        
        // 动态导航状态
        this.finalTarget = null;
        this.currentSubTarget = null;
        this.plannedPath = [];
        this.pathIndex = 0;
        this.lastPosition = null;
        this.stuckCounter = 0;
        this.maxStuckCount = 3;
        
        // 知识地图
        this.knowledgeMap = new Map();
        this.obstacleMap = new Set();
        this.safeAreas = new Set();
        this.exploredBoundary = new Map();
        
        // 重规划参数
        this.replanThreshold = 3.0;
        this.replanInterval = 1000;
        this.lastReplanTime = 0;
        this.forceReplanDistance = 8.0;
        
        // 绕行策略
        this.avoidanceRadius = 5.0;
        this.detourAngleStep = 30;
        this.maxDetourAttempts = 12;
        
        // 路径质量评估
        this.pathQualityCache = new Map();
        this.qualityCacheTimeout = 10000;
        // 卡住点记录
        this.stuckPositions = new Map(); // key: posKey, value: timestamp
        this.stuckTimeout = 20000; // 20秒后自动移除
        // 路径记忆，避免重复
        this.recentPath = [];
        this.recentPathMaxLength = 30;
        // 死胡同点集合
        this.deadEnds = new Set();
        // 连续卡住自救参数
        this.stuckRescueThreshold = 10;
        this.stuckRescueCounter = 0;
        // 记录最近N步位置用于卡住检测
        this.lastPositions = [];
        this.lastPositionsMax = 6;
        
        // 定义忽略方块白名单
        this.IGNORE_BLOCKS = ['poppy', 'dandelion', 'oxeye_daisy', 'torch', 'oak_trapdoor'];
    }

    async exploreToTarget(targetPos) {
        const currentPos = this.bot.entity.position;
        console.log(`增量式探索到: (${targetPos.x.toFixed(1)}, ${targetPos.y.toFixed(1)}, ${targetPos.z.toFixed(1)})`);
        
        this.updateKnowledgeMap();
        
        if (!this.finalTarget || this.distance2D(targetPos, this.finalTarget) > 2.0) {
            this.finalTarget = targetPos;
            this.plannedPath = [];
            this.pathIndex = 0;
            console.log('设置新的最终目标');
        }
        
        if (this.needsReplanning(currentPos)) {
            console.log('触发重规划');
            await this.replanPath(currentPos);
        }
        
        // 卡住检测，优先自救
        if (this.isStuck(currentPos)) {
            console.log('检测到卡住，优先自救');
            return await this.stuckRescueMove(currentPos);
        }
        
        const nextStep = await this.getNextStep(currentPos);
        if (nextStep) {
            this.updatePositionTracking(currentPos);
            console.log(`下一步: (${nextStep.x.toFixed(1)}, ${nextStep.y.toFixed(1)}, ${nextStep.z.toFixed(1)})`);
            return [currentPos, nextStep];
        }
        
        console.log('常规路径失败，使用探索性移动');
        return await this.exploratoryMovement(currentPos);
    }

    updateKnowledgeMap() {
        if (!this.perception || typeof this.perception.getMemoryBlocksArray !== 'function') {
            return;
        }
        
        const memoryBlocks = this.perception.getMemoryBlocksArray();
        const currentTime = Date.now();
        
        this.cleanupKnowledgeMap(currentTime);
        
        for (const block of memoryBlocks) {
            const key = this.getPositionKey(block.position);
            this.knowledgeMap.set(key, {
                block: block,
                timestamp: currentTime,
                safe: this.evaluateBlockSafety(block.type),
                passable: this.isBlockPassable(block)
            });
            
            if (this.isBlockObstacle(block)) {
                this.obstacleMap.add(key);
                this.safeAreas.delete(key);
                
                // 如果是栅栏，标记上方一格为障碍物
                if (block.type.toLowerCase().includes('fence')) {
                    const aboveKey = this.getPositionKey({
                        x: block.position.x,
                        y: block.position.y + 1,
                        z: block.position.z
                    });
                    this.obstacleMap.add(aboveKey);
                    this.safeAreas.delete(aboveKey);
                    this.knowledgeMap.set(aboveKey, {
                        block: { type: 'air', position: { x: block.position.x, y: block.position.y + 1, z: block.position.z } },
                        timestamp: currentTime,
                        safe: 0.0,
                        passable: false
                    });
                }
            } else if (this.isBlockSafe(block.type)) {
                this.safeAreas.add(key);
                this.obstacleMap.delete(key);
            }
            
            this.updateExploredBoundary(block.position);
        }
        
        console.log(`知识地图更新: ${this.knowledgeMap.size} 个位置, ${this.obstacleMap.size} 个障碍物, ${this.safeAreas.size} 个安全区域`);
    }

    needsReplanning(currentPos) {
        const now = Date.now();
        
        if (now - this.lastReplanTime < this.replanInterval) {
            return false;
        }
        
        if (this.isStuck(currentPos)) {
            console.log('检测到卡住，需要重规划');
            // 记录卡住点
            const stuckKey = this.getPositionKey(currentPos);
            this.stuckPositions.set(stuckKey, Date.now());
            return true;
        }
        
        if (this.plannedPath.length > 0 && this.pathIndex < this.plannedPath.length) {
            const currentTarget = this.plannedPath[this.pathIndex];
            
            if (!this.isPathClearInKnowledgeMap(currentPos, currentTarget)) {
                console.log('当前路径被新发现的障碍物阻挡');
                return true;
            }
            
            if (this.distance2D(currentPos, currentTarget) > this.forceReplanDistance) {
                console.log('偏离路径太远');
                return true;
            }
        }
        
        if (this.hasFoundPath(currentPos)) {
            console.log('发现更好的路径');
            return true;
        }
        
        return this.plannedPath.length === 0 || this.pathIndex >= this.plannedPath.length;
    }

    async replanPath(currentPos) {
        console.log('开始重新规划路径');
        const startTime = Date.now();
        
        this.lastReplanTime = startTime;
        this.plannedPath = [];
        this.pathIndex = 0;
        this.stuckCounter = 0;
        
        const intermediateTarget = this.findBestIntermediateTarget(currentPos, this.finalTarget);
        console.log(`中间目标: (${intermediateTarget.x.toFixed(1)}, ${intermediateTarget.y.toFixed(1)}, ${intermediateTarget.z.toFixed(1)})`);
        
        const path = await this.knowledgeBasedAStar(currentPos, intermediateTarget);
        
        if (path && path.length > 1) {
            this.plannedPath = this.optimizePath(path);
            this.pathIndex = 1;
            console.log(`重规划完成: ${this.plannedPath.length} 个节点, 耗时 ${Date.now() - startTime}ms`);
        } else {
            this.plannedPath = await this.generateExploredPath(currentPos, intermediateTarget);
            this.pathIndex = Math.min(1, this.plannedPath.length - 1);
            console.log(`生成探索性路径: ${this.plannedPath.length} 个节点`);
        }
    }

    findBestIntermediateTarget(currentPos, finalTarget) {
        console.log('寻找最优中间目标');
        // 只有目标在已知区域且可达才直接返回
        if (this.isPositionInKnownArea(finalTarget) && this.isReachable(currentPos, finalTarget)) {
            console.log('最终目标在已知区域内且可达');
            return this.adjustToGroundKnowledge(finalTarget);
        }
        const direction = this.getDirection2D(currentPos, finalTarget);
        const candidates = [];
        for (const [key, boundaryInfo] of this.exploredBoundary) {
            const pos = this.parsePositionKey(key);
            if (!pos) continue;
            pos.y = this.getGroundLevelKnowledge(pos.x, pos.z);
            const score = this.evaluateIntermediateTarget(currentPos, pos, finalTarget, direction);
            // 只有可达的点才作为候选
            if (score > 0 && this.isReachable(currentPos, pos)) {
                candidates.push({ position: pos, score: score });
            }
        }
        for (const key of this.safeAreas) {
            const pos = this.parsePositionKey(key);
            if (!pos) continue;
            pos.y = this.getGroundLevelKnowledge(pos.x, pos.z);
            const score = this.evaluateIntermediateTarget(currentPos, pos, finalTarget, direction);
            if (score > 0 && this.isReachable(currentPos, pos)) {
                candidates.push({ position: pos, score: score });
            }
        }
        if (candidates.length > 0) {
            candidates.sort((a, b) => b.score - a.score);
            const bestTarget = candidates[0].position;
            console.log(`选择最佳中间目标: (${bestTarget.x.toFixed(1)}, ${bestTarget.y.toFixed(1)}, ${bestTarget.z.toFixed(1)}), 评分: ${candidates[0].score.toFixed(2)}`);
            return bestTarget;
        }
        console.log('没有找到合适的中间目标，使用近距离目标');
        return this.generateNearTarget(currentPos, direction);
    }

    evaluateIntermediateTarget(currentPos, candidate, finalTarget, direction) {
        if (!this.isPositionSafeKnowledge(candidate) || 
            !this.isHeightAccessible(currentPos, candidate)) {
            return 0;
        }
        
        const distanceFromCurrent = this.distance2D(currentPos, candidate);
        if (distanceFromCurrent < 2 || distanceFromCurrent > 15) {
            return 0;
        }
        
        const distanceFromFinal = this.distance2D(candidate, finalTarget);
        
        const candidateDirection = this.getDirection2D(currentPos, candidate);
        const directionAlignment = this.dot2D(direction, candidateDirection);
        
        const pathClearness = this.isPathClearInKnowledgeMap(currentPos, candidate) ? 1.0 : 0.3;
        
        const explorationValue = this.calculateExplorationValue(candidate);
        
        const progressScore = Math.max(0, 1 - (distanceFromFinal / this.distance2D(currentPos, finalTarget)));
        const directionScore = Math.max(0, directionAlignment);
        const accessibilityScore = pathClearness;
        const explorationScore = explorationValue;
        
        const totalScore = 
            progressScore * 0.4 +
            directionScore * 0.3 +
            accessibilityScore * 0.2 +
            explorationScore * 0.1;
        
        return totalScore;
    }

    async knowledgeBasedAStar(start, goal) {
        console.log('开始基于知识地图的A*寻路');
        
        const gridSize = 1;
        const openSet = [];
        const closedSet = new Set();
        const cameFrom = new Map();
        const gScore = new Map();
        const fScore = new Map();
        
        const startGrid = this.worldToGrid(start, gridSize);
        const goalGrid = this.worldToGrid(goal, gridSize);
        
        const startKey = this.gridKey(startGrid);
        const goalKey = this.gridKey(goalGrid);
        
        openSet.push(startGrid);
        gScore.set(startKey, 0);
        fScore.set(startKey, this.heuristic2D(startGrid, goalGrid));
        
        let iterations = 0;
        const maxIterations = 200;
        
        while (openSet.length > 0 && iterations < maxIterations) {
            iterations++;
            
            openSet.sort((a, b) => {
                const aKey = this.gridKey(a);
                const bKey = this.gridKey(b);
                return (fScore.get(aKey) || Infinity) - (fScore.get(bKey) || Infinity);
            });
            
            const current = openSet.shift();
            const currentKey = this.gridKey(current);
            
            if (this.gridDistance(current, goalGrid) < 1.5) {
                console.log(`A*成功: ${iterations} 次迭代`);
                return this.reconstructPath(cameFrom, current, goalGrid, gridSize);
            }
            
            closedSet.add(currentKey);
            
            const neighbors = this.getKnowledgeBasedNeighbors(current, gridSize);
            
            for (const neighbor of neighbors) {
                const neighborKey = this.gridKey(neighbor);
                
                if (closedSet.has(neighborKey)) {
                    continue;
                }
                
                const worldPos = this.gridToWorld(neighbor, gridSize);
                worldPos.y = this.getGroundLevelKnowledge(worldPos.x, worldPos.z);
                
                if (!this.isPositionSafeKnowledge(worldPos)) {
                    continue;
                }
                
                const moveCost = this.calculateMoveCost(current, neighbor, gridSize);
                const tentativeGScore = (gScore.get(currentKey) || Infinity) + moveCost;
                
                if (!openSet.find(n => this.gridKey(n) === neighborKey)) {
                    openSet.push(neighbor);
                } else if (tentativeGScore >= (gScore.get(neighborKey) || Infinity)) {
                    continue;
                }
                
                cameFrom.set(neighborKey, current);
                gScore.set(neighborKey, tentativeGScore);
                fScore.set(neighborKey, tentativeGScore + this.heuristic2D(neighbor, goalGrid));
            }
            
            if (iterations % 50 === 0) {
                console.log(`A*进度: ${iterations}/${maxIterations}, 开放集: ${openSet.length}, 已访问: ${closedSet.size}`);
            }
        }
        
        console.log(`A*未找到路径: ${iterations} 次迭代后终止`);
        return null;
    }

    async getNextStep(currentPos) {
        if (this.plannedPath.length > 0 && this.pathIndex < this.plannedPath.length) {
            const nextWaypoint = this.plannedPath[this.pathIndex];
            if (this.distance2D(currentPos, nextWaypoint) < this.goalRadius) {
                this.pathIndex++;
                console.log(`到达航点 ${this.pathIndex - 1}, 前往下一个目标`);
                // 死胡同检测
                if (this.isDeadEnd(currentPos)) {
                    console.log('当前位置为死胡同，加入deadEnds并重规划');
                    this.deadEnds.add(this.getPositionKey(currentPos));
                    await this.replanPath(currentPos);
                    return null;
                }
                if (this.pathIndex < this.plannedPath.length) {
                    return this.plannedPath[this.pathIndex];
                } else {
                    console.log('已完成计划路径');
                    return null;
                }
            }
            if (this.isPathClearInKnowledgeMap(currentPos, nextWaypoint) && 
                this.isHeightAccessible(currentPos, nextWaypoint)) {
                return nextWaypoint;
            } else {
                console.log('计划路径被阻挡，寻找绕行路径');
                return await this.findDetourPath(currentPos, nextWaypoint);
            }
        }
        // 如果没有计划路径，且卡住，优先自救
        if (this.isStuck(currentPos)) {
            console.log('检测到卡住（无计划路径），优先自救');
            return (await this.stuckRescueMove(currentPos))[1];
        }
        return null;
    }

    async findDetourPath(currentPos, blockedTarget) {
        console.log('寻找绕行路径');
        
        const direction = this.getDirection2D(currentPos, blockedTarget);
        const perpendicular = this.getPerpendicular2D(direction);
        
        const detourOptions = [];
        
        for (let side of [-1, 1]) {
            for (let distance = 2; distance <= this.avoidanceRadius; distance += 1) {
                for (let forward = 1; forward <= 3; forward += 1) {
                    const detourPoint = {
                        x: currentPos.x + direction.x * forward + perpendicular.x * distance * side,
                        z: currentPos.z + direction.z * forward + perpendicular.z * distance * side
                    };
                    detourPoint.y = this.getGroundLevelKnowledge(detourPoint.x, detourPoint.z);
                    
                    if (this.isPositionSafeKnowledge(detourPoint) &&
                        this.isPathClearInKnowledgeMap(currentPos, detourPoint) &&
                        this.isHeightAccessible(currentPos, detourPoint)) {
                        
                        const score = this.evaluateDetourOption(currentPos, detourPoint, blockedTarget);
                        detourOptions.push({ position: detourPoint, score: score });
                    }
                }
            }
        }
        
        if (detourOptions.length > 0) {
            detourOptions.sort((a, b) => b.score - a.score);
            const bestDetour = detourOptions[0].position;
            console.log(`找到绕行路径: (${bestDetour.x.toFixed(1)}, ${bestDetour.y.toFixed(1)}, ${bestDetour.z.toFixed(1)})`);
            
            this.plannedPath.splice(this.pathIndex, 0, bestDetour);
            return bestDetour;
        }
        
        console.log('未找到合适的绕行路径');
        return null;
    }

    async exploratoryMovement(currentPos) {
        console.log('执行探索性移动');
        // 1. 朝向未探索区域移动
        const explorationTarget = this.findNearestUnexploredArea(currentPos);
        if (explorationTarget && this.isReachable(currentPos, explorationTarget)) {
            console.log(`朝向未探索区域移动: (${explorationTarget.x.toFixed(1)}, ${explorationTarget.y.toFixed(1)}, ${explorationTarget.z.toFixed(1)})`);
            return [currentPos, explorationTarget];
        }
        // 2. 随机安全移动
        let randomSafeTarget = null;
        for (let i = 0; i < 10; i++) {
            randomSafeTarget = this.findRandomSafeMovement(currentPos);
            if (randomSafeTarget && this.isReachable(currentPos, randomSafeTarget)) break;
            randomSafeTarget = null;
        }
        if (randomSafeTarget) {
            console.log(`随机安全移动: (${randomSafeTarget.x.toFixed(1)}, ${randomSafeTarget.y.toFixed(1)}, ${randomSafeTarget.z.toFixed(1)})`);
            return [currentPos, randomSafeTarget];
        }
        // 3. 执行微小移动
        console.log('执行微小移动');
        return [currentPos, {
            x: currentPos.x + (Math.random() - 0.5) * 0.5,
            y: currentPos.y,
            z: currentPos.z + (Math.random() - 0.5) * 0.5
        }];
    }

    updatePositionTracking(currentPos) {
        if (this.lastPosition) {
            const movement = this.distance2D(currentPos, this.lastPosition);
            if (movement < 0.5) {
                this.stuckCounter++;
                this.stuckRescueCounter++;
            } else {
                this.stuckCounter = 0;
                this.stuckRescueCounter = 0;
            }
        }
        this.lastPosition = { ...currentPos };
        // 路径记忆
        const posKey = this.getPositionKey(currentPos);
        this.recentPath.push(posKey);
        if (this.recentPath.length > this.recentPathMaxLength) {
            this.recentPath.shift();
        }
        // 连续卡住自救：超过阈值自动清理deadEnds和recentPath
        if (this.stuckRescueCounter > this.stuckRescueThreshold) {
            console.log('连续卡住，自动清理deadEnds和recentPath以自救');
            this.deadEnds.clear();
            this.recentPath = [];
            this.stuckRescueCounter = 0;
        }
        // 记录最近N步位置
        this.lastPositions.push({ ...currentPos });
        if (this.lastPositions.length > this.lastPositionsMax) {
            this.lastPositions.shift();
        }
    }

    isStuck(currentPos) {
        if (this.stuckCounter >= this.maxStuckCount) return true;
        if (this.lastPositions.length === this.lastPositionsMax) {
            const first = this.lastPositions[0];
            if (this.lastPositions.every(p => this.distance2D(p, first) < 0.1)) {
                return true;
            }
        }
        return false;
    }

    isPathClearInKnowledgeMap(start, end) {
        const steps = Math.ceil(this.distance2D(start, end) * 2);
        
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const checkPos = {
                x: start.x + (end.x - start.x) * t,
                z: start.z + (end.z - start.z) * t
            };
            checkPos.y = this.getGroundLevelKnowledge(checkPos.x, checkPos.z);
            
            if (!this.isPositionSafeKnowledge(checkPos)) {
                return false;
            }
        }
        
        return true;
    }

    isPositionSafeKnowledge(position) {
        // 体积判定：以目标点为中心，检查周围±0.3格的四个角和中心点
        const offsets = [
            {x: 0, z: 0},
            {x: 0.3, z: 0.3},
            {x: 0.3, z: -0.3},
            {x: -0.3, z: 0.3},
            {x: -0.3, z: -0.3}
        ];
        for (const offset of offsets) {
            const checkPos = {
                x: position.x + offset.x,
                y: position.y,
                z: position.z + offset.z
            };
            const posKey = this.getPositionKey(checkPos);
            // 避免重复走同一路径
            if (this.recentPath.includes(posKey)) return false;
            if (this.stuckPositions.has(posKey)) return false;
            if (this.deadEnds.has(posKey)) return false;
            const groundKey = this.getPositionKey({
                x: Math.floor(checkPos.x),
                y: Math.floor(checkPos.y - 1),
                z: Math.floor(checkPos.z)
            });
            const bodyKey = this.getPositionKey({
                x: Math.floor(checkPos.x),
                y: Math.floor(checkPos.y),
                z: Math.floor(checkPos.z)
            });
            const headKey = this.getPositionKey({
                x: Math.floor(checkPos.x),
                y: Math.floor(checkPos.y + 1),
                z: Math.floor(checkPos.z)
            });
            if (this.obstacleMap.has(bodyKey) || this.obstacleMap.has(headKey)) {
                return false;
            }
            if (this.safeAreas.has(bodyKey)) {
                continue;
            }
            const groundInfo = this.knowledgeMap.get(groundKey);
            const bodyInfo = this.knowledgeMap.get(bodyKey);
            const headInfo = this.knowledgeMap.get(headKey);
            // 水面、trapdoor等特殊方块判定为不可走
            if (groundInfo && (groundInfo.block.type === 'air' || 
                groundInfo.block.type.toLowerCase().includes('water') ||
                groundInfo.block.type.toLowerCase().includes('trapdoor'))) {
                return false;
            }
            if (bodyInfo && !bodyInfo.passable) {
                return false;
            }
            if (headInfo && !headInfo.passable) {
                return false;
            }
            // 检查下方是否为栅栏
            if (groundInfo && groundInfo.block.type.toLowerCase().includes('fence')) {
                return false;
            }
        }
        return true;
    }

    getGroundLevelKnowledge(x, z) {
        let maxGroundY = Math.floor(this.bot.entity.position.y);
        
        for (let y = maxGroundY + 5; y >= maxGroundY - 5; y--) {
            const key = this.getPositionKey({ x: Math.floor(x), y: y, z: Math.floor(z) });
            const info = this.knowledgeMap.get(key);
            
            if (info && info.block.type !== 'air' && !info.block.type.toLowerCase().includes('water') && !info.block.type.toLowerCase().includes('fence')) {
                return y + 1;
            }
        }
        
        return maxGroundY;
    }

    getPositionKey(pos) {
        return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
    }

    parsePositionKey(key) {
        const parts = key.split(',');
        if (parts.length !== 3) return null;
        return {
            x: parseInt(parts[0]),
            y: parseInt(parts[1]),
            z: parseInt(parts[2])
        };
    }

    distance2D(pos1, pos2) {
        return Math.sqrt((pos1.x - pos2.x) ** 2 + (pos1.z - pos2.z) ** 2);
    }

    getDirection2D(from, to) {
        const direction = {
            x: to.x - from.x,
            z: to.z - from.z
        };
        
        const length = Math.sqrt(direction.x ** 2 + direction.z ** 2);
        if (length === 0) return { x: 0, z: 0 };
        
        return {
            x: direction.x / length,
            z: direction.z / length
        };
    }

    getPerpendicular2D(direction) {
        return {
            x: -direction.z,
            z: direction.x
        };
    }

    isHeightAccessible(from, to) {
        const heightDiff = to.y - from.y;
        return Math.abs(heightDiff) <= this.maxJumpHeight;
    }

    evaluateBlockSafety(blockType) {
        if (blockType === 'air') return 1.0;
        if (blockType.toLowerCase().includes('water')) return 0.0;
        if (blockType.toLowerCase().includes('lava')) return 0.0;
        if (blockType.toLowerCase().includes('fence')) return 0.0;
        if (['grass_block', 'dirt', 'stone', 'cobblestone'].includes(blockType)) return 0.8;
        return 0.5;
    }

    isBlockPassable(block) {
        return block.type === 'air' || 
               block.type.toLowerCase().includes('grass') ||
               this.IGNORE_BLOCKS.some(f => block.type.toLowerCase().includes(f));
    }

    isBlockObstacle(block) {
        return block.type !== 'air' && 
               !block.type.toLowerCase().includes('grass') &&
               !block.type.toLowerCase().includes('poppy') &&
               (block.type.toLowerCase().includes('water') || block.type.toLowerCase().includes('fence'));
    }

    isBlockSafe(blockType) {
        return ['grass_block', 'dirt', 'stone', 'cobblestone'].includes(blockType) &&
               !blockType.toLowerCase().includes('water') &&
               !blockType.toLowerCase().includes('fence');
    }

    cleanupKnowledgeMap(currentTime) {
        const maxAge = 60000;
        const keysToDelete = [];
        
        for (const [key, info] of this.knowledgeMap) {
            if (currentTime - info.timestamp > maxAge) {
                keysToDelete.push(key);
            }
        }
        
        for (const key of keysToDelete) {
            this.knowledgeMap.delete(key);
            this.obstacleMap.delete(key);
            this.safeAreas.delete(key);
        }
        // 清理过期的卡住点
        for (const [key, ts] of this.stuckPositions) {
            if (currentTime - ts > this.stuckTimeout) {
                this.stuckPositions.delete(key);
            }
        }
    }

    updateExploredBoundary(position) {
        const key = this.getPositionKey(position);
        this.exploredBoundary.set(key, {
            position: position,
            timestamp: Date.now()
        });
    }

    isPositionInKnownArea(position) {
        const searchRadius = 2;
        for (let dx = -searchRadius; dx <= searchRadius; dx++) {
            for (let dz = -searchRadius; dz <= searchRadius; dz++) {
                const checkKey = this.getPositionKey({
                    x: position.x + dx,
                    y: position.y,
                    z: position.z + dz
                });
                if (this.knowledgeMap.has(checkKey)) {
                    return true;
                }
            }
        }
        return false;
    }

    adjustToGroundKnowledge(position) {
        const groundY = this.getGroundLevelKnowledge(position.x, position.z);
        return { x: position.x, y: groundY, z: position.z };
    }

    generateNearTarget(currentPos, direction) {
        const distance = 3;
        return {
            x: currentPos.x + direction.x * distance,
            y: currentPos.y,
            z: currentPos.z + direction.z * distance
        };
    }

    calculateExplorationValue(position) {
        const nearbyUnknown = this.countNearbyUnknownCells(position, 5);
        return Math.min(1.0, nearbyUnknown / 20);
    }

    countNearbyUnknownCells(position, radius) {
        let count = 0;
        for (let x = -radius; x <= radius; x++) {
            for (let z = -radius; z <= radius; z++) {
                const checkKey = this.getPositionKey({
                    x: position.x + x,
                    y: position.y,
                    z: position.z + z
                });
                if (!this.knowledgeMap.has(checkKey)) {
                    count++;
                }
            }
        }
        return count;
    }

    dot2D(v1, v2) {
        return v1.x * v2.x + v1.z * v2.z;
    }

    hasFoundPath(currentPos) {
        return false;
    }

    worldToGrid(pos, gridSize) {
        return {
            x: Math.floor(pos.x / gridSize),
            y: Math.floor(pos.y / gridSize),
            z: Math.floor(pos.z / gridSize)
        };
    }

    gridToWorld(gridPos, gridSize) {
        return {
            x: gridPos.x * gridSize + gridSize / 2,
            y: gridPos.y * gridSize + gridSize / 2,
            z: gridPos.z * gridSize + gridSize / 2
        };
    }

    gridKey(gridPos) {
        return `${gridPos.x},${gridPos.y},${gridPos.z}`;
    }

    heuristic2D(a, b) {
        return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
    }

    gridDistance(a, b) {
        return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
    }

    getKnowledgeBasedNeighbors(gridPos, gridSize) {
        const neighbors = [];
        const directions = [
            {x: 1, z: 0}, {x: -1, z: 0}, {x: 0, z: 1}, {x: 0, z: -1},
            {x: 1, z: 1}, {x: -1, z: -1}, {x: 1, z: -1}, {x: -1, z: 1}
        ];
        // Fisher-Yates 洗牌算法打乱顺序
        for (let i = directions.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [directions[i], directions[j]] = [directions[j], directions[i]];
        }
        for (const dir of directions) {
            neighbors.push({
                x: gridPos.x + dir.x,
                y: gridPos.y,
                z: gridPos.z + dir.z
            });
        }
        return neighbors;
    }

    calculateMoveCost(from, to, gridSize) {
        const dx = Math.abs(to.x - from.x);
        const dz = Math.abs(to.z - from.z);
        
        if (dx === 1 && dz === 1) {
            return 1.414;
        } else {
            return 1.0;
        }
    }

    reconstructPath(cameFrom, current, goal, gridSize) {
        const path = [];
        let currentNode = current;
        
        const goalWorld = this.gridToWorld(goal, gridSize);
        goalWorld.y = this.getGroundLevelKnowledge(goalWorld.x, goalWorld.z);
        path.unshift(goalWorld);
        
        while (currentNode && cameFrom.has(this.gridKey(currentNode))) {
            const worldPos = this.gridToWorld(currentNode, gridSize);
            worldPos.y = this.getGroundLevelKnowledge(worldPos.x, worldPos.z);
            path.unshift(worldPos);
            currentNode = cameFrom.get(this.gridKey(currentNode));
        }
        
        return path;
    }

    optimizePath(path) {
        if (!path || path.length <= 2) return path;
        
        const optimized = [path[0]];
        let i = 0;
        
        while (i < path.length - 1) {
            let j = Math.min(i + 3, path.length - 1);
            
            while (j > i + 1 && !this.isPathClearInKnowledgeMap(path[i], path[j])) {
                j--;
            }
            
            optimized.push(path[j]);
            i = j;
        }
        
        return optimized;
    }

    async generateExploredPath(currentPos, target) {
        const direction = this.getDirection2D(currentPos, target);
        const distance = this.distance2D(currentPos, target);
        const steps = Math.min(5, Math.floor(distance / 2));
        
        const path = [currentPos];
        
        for (let i = 1; i <= steps; i++) {
            const stepPos = {
                x: currentPos.x + direction.x * i * 2,
                z: currentPos.z + direction.z * i * 2
            };
            stepPos.y = this.getGroundLevelKnowledge(stepPos.x, stepPos.z);
            
            if (this.isPositionSafeKnowledge(stepPos)) {
                path.push(stepPos);
            }
        }
        
        return path;
    }

    evaluateDetourOption(currentPos, detourPoint, originalTarget) {
        const detourDistance = this.distance2D(currentPos, detourPoint);
        const progressToTarget = this.distance2D(detourPoint, originalTarget);
        const directDistance = this.distance2D(currentPos, originalTarget);
        
        const progressScore = Math.max(0, 1 - (progressToTarget / directDistance));
        const efficiencyScore = Math.max(0, 1 - (detourDistance / 5));
        
        return progressScore * 0.7 + efficiencyScore * 0.3;
    }

    findNearestUnexploredArea(currentPos) {
        let bestTarget = null;
        let bestScore = -1;
        
        const searchRadius = 8;
        for (let x = -searchRadius; x <= searchRadius; x += 2) {
            for (let z = -searchRadius; z <= searchRadius; z += 2) {
                const checkPos = {
                    x: currentPos.x + x,
                    z: currentPos.z + z
                };
                checkPos.y = this.getGroundLevelKnowledge(checkPos.x, checkPos.z);
                
                if (!this.isPositionInKnownArea(checkPos) && 
                    this.isPositionSafeKnowledge(checkPos)) {
                    
                    const distance = this.distance2D(currentPos, checkPos);
                    const score = 1 / (distance + 1);
                    
                    if (score > bestScore) {
                        bestScore = score;
                        bestTarget = checkPos;
                    }
                }
            }
        }
        
        return bestTarget;
    }

    findRandomSafeMovement(currentPos) {
        const attempts = 10;
        
        for (let i = 0; i < attempts; i++) {
            const angle = Math.random() * Math.PI * 2;
            const distance = 1 + Math.random() * 3;
            
            const target = {
                x: currentPos.x + Math.cos(angle) * distance,
                z: currentPos.z + Math.sin(angle) * distance
            };
            target.y = this.getGroundLevelKnowledge(target.x, target.z);
            
            if (this.isPositionSafeKnowledge(target) && 
                this.isHeightAccessible(currentPos, target)) {
                return target;
            }
        }
        
        return null;
    }

    // 判断from到to是否连通（BFS，步数限制）
    isReachable(from, to) {
        const visited = new Set();
        const queue = [{ x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) }];
        const targetKey = this.getPositionKey({ x: Math.floor(to.x), y: Math.floor(to.y), z: Math.floor(to.z) });
        const maxSteps = 100;
        let steps = 0;
        while (queue.length > 0 && steps < maxSteps) {
            const pos = queue.shift();
            const key = this.getPositionKey(pos);
            if (visited.has(key)) continue;
            visited.add(key);
            if (key === targetKey || this.distance2D(pos, to) < 1.0) return true;
            for (const dir of [
                {x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}
            ]) {
                const next = {x: pos.x+dir.x, y: pos.y, z: pos.z+dir.z};
                next.y = this.getGroundLevelKnowledge(next.x, next.z);
                if (this.isPositionSafeKnowledge(next)) {
                    queue.push(next);
                }
            }
            steps++;
        }
        return false;
    }

    // 死胡同检测：判断当前位置四周是否有安全可达点
    isDeadEnd(pos) {
        for (const dir of [
            {x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}
        ]) {
            const next = {x: pos.x+dir.x, y: pos.y, z: pos.z+dir.z};
            next.y = this.getGroundLevelKnowledge(next.x, next.z);
            if (this.isPositionSafeKnowledge(next)) {
                return false;
            }
        }
        return true;
    }

    // 卡住时优先尝试跳一跳或四周自救
    async stuckRescueMove(currentPos) {
        const jumpDirs = [
            {x: 1, z: 0}, {x: -1, z: 0}, {x: 0, z: 1}, {x: 0, z: -1},
            {x: 1, z: 1}, {x: -1, z: -1}, {x: 1, z: -1}, {x: -1, z: 1}
        ];
        for (const dir of jumpDirs) {
            // 尝试跳一跳
            const tryPos = {
                x: currentPos.x + dir.x,
                y: currentPos.y + 1,
                z: currentPos.z + dir.z
            };
            if (this.isPositionSafeKnowledge(tryPos)) {
                console.log('卡住自救：尝试跳一跳');
                return [currentPos, tryPos];
            }
            // 尝试平移一格
            const tryPos2 = {
                x: currentPos.x + dir.x,
                y: currentPos.y,
                z: currentPos.z + dir.z
            };
            if (this.isPositionSafeKnowledge(tryPos2)) {
                console.log('卡住自救：尝试平移一格');
                return [currentPos, tryPos2];
            }
        }
        // 实在不行就原地微小扰动
        return [currentPos, {
            x: currentPos.x + (Math.random() - 0.5) * 0.5,
            y: currentPos.y,
            z: currentPos.z + (Math.random() - 0.5) * 0.5
        }];
    }
}

module.exports = AdaptiveExplorer;