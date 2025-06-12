const { Vec3 } = require('vec3');

class EnvironmentPerception {
    constructor(bot, maxDistance = 256) {
        this.bot = bot;
        this.maxDistance = Math.min(maxDistance,256);
        this.visibleBlocks = new Map();
        this.blockCache = new Map();
        this.memoryMap = new Map();
        this.lastUpdateTime = 0;
        this.updateInterval = 200;
        this.lastBotPosition = null;
        this.movementThreshold = 1.0;
        this.lastBotYaw = null;
        
        // 放宽视线感知配置
        this.visionConfig = {
            scanRadius: this.maxDistance,
            verticalScanRange: 8,
            blockSampleStep: 1, // 保留
            lineOfSightStep: 0.5,
            maxBlocksToCheck: 1200, // 降低最大检查数
            minDistanceCheck: 0.5,
        };
        
        this.eyeHeightOffset = 1.62;
        
        console.log(`视线感知系统初始化，扫描半径: ${this.visionConfig.scanRadius}`);
    }

    updatePerception() {
        // 只用异步分批扫描，兼容老接口
        const result = this.updatePerceptionAsync();
        if (result && typeof result.then === 'function') {
            result.then(() => this.printAllUniqueBlockNames());
        } else {
            this.printAllUniqueBlockNames();
        }
        return result;
    }

    performLineOfSightScan() {
        const botPosition = this.bot.entity.position;
        const eyePosition = {
            x: botPosition.x,
            y: botPosition.y + this.eyeHeightOffset,
            z: botPosition.z
        };
        
        const candidateBlocks = this.generateCandidateBlocks(botPosition);
        console.log(`需要检查 ${candidateBlocks.length} 个候选方块`);
        
        let checkedCount = 0;
        let visibleCount = 0;
        let skippedAirBlocks = 0;
        
        for (const blockPos of candidateBlocks) {
            checkedCount++;
            
            // 首先检查方块是否存在且非空气
            const block = this.getBlockFromCache(blockPos);
            if (!block || block.name.includes('air') || block.name.includes('short_grass')) {
                skippedAirBlocks++;
                continue;
            }
            
            // 放宽的视线检测
            if (this.isBlockVisibleRelaxed(eyePosition, blockPos)) {
                const distance = this.calculateDistance(eyePosition, blockPos);
                const key = `${blockPos.x},${blockPos.y},${blockPos.z}`;
                
                this.visibleBlocks.set(key, {
                    position: { x: blockPos.x, y: blockPos.y, z: blockPos.z },
                    type: block.name,
                    distance: distance,
                    blockId: block.type,
                    metadata: block.metadata || 0
                });
                visibleCount++;
            }
            
            if (checkedCount % 200 === 0) {
                console.log(`视线检查进度: ${checkedCount}/${candidateBlocks.length}, 可见: ${visibleCount}, 跳过空气: ${skippedAirBlocks}`);
            }
        }
        
        console.log(`视线检查完成: 检查了 ${checkedCount} 个方块, 发现 ${visibleCount} 个可见方块, 跳过 ${skippedAirBlocks} 个空气方块`);
    }

    generateCandidateBlocks(botPosition) {
        // 动态步长采样：中心高密度，外围低密度
        const candidates = [];
        const { scanRadius, verticalScanRange } = this.visionConfig;
        for (let r = 1; r <= scanRadius; r += (r < 8 ? 1 : (r < 20 ? 2 : 3))) {
            for (let angle = 0; angle < 360; angle += 10) {
                const x = Math.floor(botPosition.x + r * Math.cos(angle * Math.PI / 180));
                const z = Math.floor(botPosition.z + r * Math.sin(angle * Math.PI / 180));
                for (let y = Math.floor(botPosition.y - 2); y <= Math.floor(botPosition.y + verticalScanRange); y++) {
                    candidates.push({ x, y, z });
                }
            }
        }
        // 去重
        const unique = {};
        candidates.forEach(b => unique[`${b.x},${b.y},${b.z}`] = b);
        return Object.values(unique).slice(0, this.visionConfig.maxBlocksToCheck);
    }

    isBlockVisibleRelaxed(eyePosition, targetBlockPos) {
        const blockCenter = {
            x: targetBlockPos.x + 0.5,
            y: targetBlockPos.y + 0.5,
            z: targetBlockPos.z + 0.5
        };
        
        const direction = {
            x: blockCenter.x - eyePosition.x,
            y: blockCenter.y - eyePosition.y,
            z: blockCenter.z - eyePosition.z
        };
        
        const totalDistance = Math.sqrt(
            direction.x * direction.x + 
            direction.y * direction.y + 
            direction.z * direction.z
        );
        
        if (totalDistance === 0) return true;
        if (totalDistance <= 2.0) return true; // 近距离直接可见
        
        // 标准化方向向量
        direction.x /= totalDistance;
        direction.y /= totalDistance;
        direction.z /= totalDistance;
        
        // 放宽的视线检测
        return this.checkLineOfSightRelaxed(eyePosition, direction, totalDistance, targetBlockPos);
    }

    checkLineOfSightRelaxed(startPos, direction, maxDistance, targetBlockPos) {
        const step = this.visionConfig.lineOfSightStep;
        let currentPos = { ...startPos };
        let distance = 0;
        let obstructionCount = 0;
        const maxObstructions = 2; // 允许少量遮挡
        
        // 在超平坦世界中，主要是检查水平遮挡
        while (distance < maxDistance - 1.0) {
            currentPos.x += direction.x * step;
            currentPos.y += direction.y * step;
            currentPos.z += direction.z * step;
            distance += step;
            
            const blockPos = {
                x: Math.floor(currentPos.x),
                y: Math.floor(currentPos.y),
                z: Math.floor(currentPos.z)
            };
            
            // 跳过起始位置和目标位置
            if (distance < 1.0) continue;
            if (blockPos.x === targetBlockPos.x && 
                blockPos.y === targetBlockPos.y && 
                blockPos.z === targetBlockPos.z) {
                continue;
            }
            
            const block = this.getBlockFromCache(blockPos);
            if (this.isBlockObstructingRelaxed(block, currentPos, blockPos)) {
                obstructionCount++;
                if (obstructionCount > maxObstructions) {
                    return false; // 遮挡物太多
                }
            }
        }
        
        return true; // 允许少量遮挡的视线
    }

    isBlockObstructingRelaxed(block, rayPos, blockPos) {
        if (!block || block.name === 'air') {
            return false;
        }
        
        // 在超平坦世界中，主要的"遮挡物"可能是草、花等
        const nonObstructingBlocks = [
            'grass', 'tall_grass', 'dead_bush', 'poppy', 'dandelion',
            'wheat', 'carrots', 'potatoes', 'beetroots', 'sugar_cane',
            'vine', 'web', 'torch', 'redstone_torch', 'flower', 'sapling',
            'water', 'glass', 'glass_pane', 'ice', 'leaves', 'fence'
        ];
        
        // 这些方块不算真正的遮挡
        if (nonObstructingBlocks.some(name => block.name.includes(name))) {
            return false;
        }
        
        // 只有真正的实体方块才算遮挡
        return this.doesRayIntersectBlockRelaxed(rayPos, blockPos, block);
    }

    doesRayIntersectBlockRelaxed(rayPos, blockPos, block) {
        // 放宽的碰撞检测，给一些容差
        const margin = 0.1;
        const blockBounds = {
            minX: blockPos.x + margin,
            maxX: blockPos.x + 1 - margin,
            minY: blockPos.y + margin,
            maxY: blockPos.y + 1 - margin,
            minZ: blockPos.z + margin,
            maxZ: blockPos.z + 1 - margin
        };
        
        // 特殊方块处理
        if (block.name.includes('slab') && !block.name.includes('double')) {
            blockBounds.maxY = blockPos.y + 0.5 - margin;
        }
        
        return (rayPos.x >= blockBounds.minX && rayPos.x <= blockBounds.maxX &&
                rayPos.y >= blockBounds.minY && rayPos.y <= blockBounds.maxY &&
                rayPos.z >= blockBounds.minZ && rayPos.z <= blockBounds.maxZ);
    }

    getBlockFromCache(blockPos) {
        const key = `${blockPos.x},${blockPos.y},${blockPos.z}`;
        
        if (this.blockCache.has(key)) {
            const cachedItem = this.blockCache.get(key);
            if (Date.now() - cachedItem.timestamp < 10000) {
                return cachedItem.block;
            } else {
                this.blockCache.delete(key);
            }
        }
        
        try {
            const block = this.bot.blockAt(new Vec3(blockPos.x, blockPos.y, blockPos.z));
            
            this.blockCache.set(key, {
                block: block,
                timestamp: Date.now()
            });
            
            if (this.blockCache.size > 5000) {
                const oldestKey = this.blockCache.keys().next().value;
                this.blockCache.delete(oldestKey);
            }
            
            return block;
            
        } catch (error) {
            return null;
        }
    }

    calculateDistance(pos1, pos2) {
        return Math.sqrt(
            Math.pow(pos1.x - pos2.x, 2) +
            Math.pow(pos1.y - pos2.y, 2) +
            Math.pow(pos1.z - pos2.z, 2)
        );
    }

    getVisibleBlocksArray() {
        return Array.from(this.visibleBlocks.values())
            .sort((a, b) => a.distance - b.distance);
    }

    getVisibleBlocksByType(blockType) {
        return this.getVisibleBlocksArray().filter(block => block.type === blockType);
    }

    getBlocksInRadius(center, radius) {
        return this.getVisibleBlocksArray().filter(block => {
            const distance = this.calculateDistance(center, block.position);
            return distance <= radius;
        });
    }

    getVisibleGroundBlocks() {
        const botY = this.bot.entity.position.y;
        return this.getVisibleBlocksArray().filter(block => {
            return block.position.y <= botY + 1 && this.isSolidBlock({ name: block.type });
        });
    }

    getGroundLevel(x, z) {
        const nearbyGroundBlocks = this.getVisibleGroundBlocks().filter(block => {
            const dx = Math.abs(block.position.x - x);
            const dz = Math.abs(block.position.z - z);
            return dx <= 3 && dz <= 3;
        });
        
        if (nearbyGroundBlocks.length === 0) {
            console.log(`警告: 在 (${x}, ${z}) 附近没有找到可见的地面方块`);
            return this.bot.entity.position.y - 1;
        }
        
        let maxGroundY = -Infinity;
        for (const block of nearbyGroundBlocks) {
            if (block.position.y > maxGroundY) {
                maxGroundY = block.position.y;
            }
        }
        
        console.log(`在 (${x}, ${z}) 找到地面高度: ${maxGroundY + 1}`);
        return maxGroundY + 1;
    }

    isPositionWalkable(position) {
        const tolerance = 1.5;
        
        const supportBlocks = this.getVisibleBlocksArray().filter(block => {
            const dx = Math.abs(block.position.x - position.x);
            const dy = Math.abs(block.position.y - (position.y - 1));
            const dz = Math.abs(block.position.z - position.z);
            return dx <= tolerance && dy <= 0.5 && dz <= tolerance && 
                   this.isSolidBlock({ name: block.type });
        });
        
        return supportBlocks.length > 0; // 简化检查，只要有支撑就行
    }

    isSolidBlock(block) {
        if (!block) return false;
        
        const nonSolidBlocks = [
            'air', 'grass', 'tall_grass', 'dead_bush', 'poppy', 'dandelion',
            'wheat', 'carrots', 'potatoes', 'beetroots', 'sugar_cane',
            'vine', 'web', 'torch', 'redstone_torch', 'lever', 'button',
            'pressure_plate', 'tripwire', 'flower', 'sapling', 'water', 'lava','short_grass'
        ];
        
        return !nonSolidBlocks.some(name => block.name.includes(name));
    }

    getLineOfSightStats() {
        const blocks = this.getVisibleBlocksArray();
        const groundBlocks = this.getVisibleGroundBlocks();
        const blocksByType = {};
        
        blocks.forEach(block => {
            blocksByType[block.type] = (blocksByType[block.type] || 0) + 1;
        });
        
        return {
            totalVisible: blocks.length,
            groundBlocks: groundBlocks.length,
            averageDistance: blocks.length > 0 ? 
                blocks.reduce((sum, block) => sum + block.distance, 0) / blocks.length : 0,
            maxDistance: blocks.length > 0 ? Math.max(...blocks.map(b => b.distance)) : 0,
            blocksByType: blocksByType,
            cacheSize: this.blockCache.size
        };
    }

    // 调试方法：强制扫描小范围
    debugScanNearby(radius = 10) {
        console.log(`调试扫描：强制扫描半径 ${radius} 范围内的所有方块`);
        const botPos = this.bot.entity.position;
        const foundBlocks = [];
        
        for (let x = Math.floor(botPos.x - radius); x <= Math.floor(botPos.x + radius); x++) {
            for (let z = Math.floor(botPos.z - radius); z <= Math.floor(botPos.z + radius); z++) {
                for (let y = Math.floor(botPos.y - 5); y <= Math.floor(botPos.y + 5); y++) {
                    const block = this.getBlockFromCache({x, y, z});
                    if (block && block.name !== 'air') {
                        foundBlocks.push({
                            position: {x, y, z},
                            type: block.name,
                            distance: this.calculateDistance(botPos, {x, y, z})
                        });
                    }
                }
            }
        }
        
        console.log(`调试扫描发现 ${foundBlocks.length} 个非空气方块:`);
        foundBlocks.slice(0, 10).forEach(block => {
            console.log(`  ${block.type} at (${block.position.x}, ${block.position.y}, ${block.position.z}) 距离: ${block.distance.toFixed(2)}`);
        });
        
        return foundBlocks;
    }

    adjustScanParameters(newParams) {
        if (typeof newParams.scanRadius === 'number') {
            // 允许动态调整最大感知距离
            this.maxDistance = Math.min(newParams.scanRadius, 128); // 128为最大允许值
            this.visionConfig.scanRadius = this.maxDistance;
        }
        Object.assign(this.visionConfig, newParams);
        console.log('视线感知参数已更新:', this.visionConfig);
    }

    cleanupCache() {
        const now = Date.now();
        const expiredKeys = [];
        
        for (const [key, item] of this.blockCache.entries()) {
            if (now - item.timestamp > 15000) {
                expiredKeys.push(key);
            }
        }
        
        expiredKeys.forEach(key => this.blockCache.delete(key));
        
        if (expiredKeys.length > 0) {
            console.log(`清理了 ${expiredKeys.length} 个过期缓存项`);
        }
    }

    getMemoryBlocksArray() {
        return Array.from(this.memoryMap.values());
    }

    async performLineOfSightScanAsync(batchSize = 200) {
        const botPosition = this.bot.entity.position;
        const eyePosition = {
            x: botPosition.x,
            y: botPosition.y + this.eyeHeightOffset,
            z: botPosition.z
        };
        const candidateBlocks = this.generateCandidateBlocks(botPosition);
        let checkedCount = 0;
        let visibleCount = 0;
        let skippedAirBlocks = 0;
        for (let i = 0; i < candidateBlocks.length; i += batchSize) {
            const batch = candidateBlocks.slice(i, i + batchSize);
            for (const blockPos of batch) {
                checkedCount++;
                const block = this.getBlockFromCache(blockPos);
                if (!block || block.name.includes('air') || block.name.includes('short_grass')) {
                    skippedAirBlocks++;
                    continue;
                }
                if (this.isBlockVisibleRelaxed(eyePosition, blockPos)) {
                    const distance = this.calculateDistance(eyePosition, blockPos);
                    const key = `${blockPos.x},${blockPos.y},${blockPos.z}`;
                    this.visibleBlocks.set(key, {
                        position: { x: blockPos.x, y: blockPos.y, z: blockPos.z },
                        type: block.name,
                        distance: distance,
                        blockId: block.type,
                        metadata: block.metadata || 0
                    });
                    visibleCount++;
                }
            }
            // 分批让出事件循环，避免阻塞
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        // 新增：同步可见方块到memoryMap
        for (const [key, block] of this.visibleBlocks.entries()) {
            if (!block.type.includes('air') && !block.type.includes('short_grass')) {
                if (!this.memoryMap.has(key)) {
                    this.memoryMap.set(key, { ...block });
                }
            }
        }
        this.printAllUniqueBlockNames();
        return { checkedCount, visibleCount, skippedAirBlocks };
    }

    async updatePerceptionAsync() {
        const now = Date.now();
        const botPosition = this.bot.entity.position;
        const botYaw = this.bot.entity.yaw;
        if (now - this.lastUpdateTime < this.updateInterval) {
            return this.getVisibleBlocksArray();
        }
        if (this.lastBotPosition !== null && this.lastBotYaw !== null) {
            const moveDistance = botPosition.distanceTo(this.lastBotPosition);
            const yawDiff = Math.abs(botYaw - this.lastBotYaw);
            if (moveDistance < this.movementThreshold && yawDiff < 0.2) {
                return this.getVisibleBlocksArray();
            }
        }
        this.lastUpdateTime = now;
        this.lastBotPosition = botPosition.clone();
        this.lastBotYaw = botYaw;
        this.visibleBlocks.clear();
        await this.performLineOfSightScanAsync(200); // 分批处理
        this.printAllUniqueBlockNames();
        return this.getVisibleBlocksArray();
    }

    printAllUniqueBlockNames() {
        // const uniqueNames = new Set();
        // for (const block of this.getVisibleBlocksArray()) {
        //     uniqueNames.add(block.type);
        // }
        // console.log('环境中所有可见方块类型：');
        // for (const name of uniqueNames) {
        //     console.log(name);
        // }
    }
}

module.exports = EnvironmentPerception;
