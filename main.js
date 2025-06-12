// ===== 依赖导入 =====
const mineflayer = require('mineflayer');
const mineflayerViewer = require('prismarine-viewer').mineflayer;
const BotController = require('./botController');
const CommandParser = require('./commandParser');
const registerCommands = require('./commands');
const EnvironmentPerception = require('./EnvironmentPerception');
const RealTimePathfinding = require('./RealTimePathfinding');
const VisualizationServer = require('./visualizationServer');

// ===== 配置参数 =====
const options = {
    username:'mineDrone',
    gamemode:1,
    host:'localhost',
    port:55916,
    version: '1.21.1'
}

// ===== 创建 Bot 实例 =====
const bot = mineflayer.createBot(options);
const controller = new BotController(bot);
const parser = new CommandParser();

// 声明变量
let perception;
let pathfinding;
let visualizationServer;

// ===== 事件与功能实现 =====

function welcome() {
    bot.chat('自定义寻路版本已启动！')
}

function setCreativeMode() {
    bot.chat('/gamemode creative');
}

function setupPathDrawing() {
    const path = [bot.entity.position.clone()];
    bot.on('move', () => {
        if (path[path.length - 1].distanceTo(bot.entity.position) > 1) {
            path.push(bot.entity.position.clone());
            bot.viewer.drawLine('path', path);
        }
    });
}

function setupCustomChatEvent() {
    bot.chatAddPattern(
        /^\[(.+)\] (\S+) > (.+)$/,
        'my_chat_event',
        'Custom chat event'
    );
    bot.on('my_chat_event', (...args) => {
        console.log('my_chat_event triggered:', args);
    });
}

function setupOtherChatEvents() {
    bot.on('hello',()=>{bot.chat('Hi~')});
    bot.on('chat', (username, message) => {
        console.log('chat:', username, message);
        
        if (message.startsWith('!goto')) {
            const coords = message.split(' ').slice(1);
            if (coords.length === 3) {
                const x = parseFloat(coords[0]);
                const y = parseFloat(coords[1]);
                const z = parseFloat(coords[2]);
                if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
                    controller.navigateTo({x, y, z});
                    bot.chat(`正在自定义导航到 ${x}, ${y}, ${z}`);
                } else {
                    bot.chat('无效坐标格式');
                }
            } else {
                bot.chat('用法: !goto x y z');
            }
        }
        
        if (message === '!stop') {
            controller.stop();
            bot.chat('导航已停止');
        }
        
        if (message === '!status') {
            const pos = bot.entity.position;
            const status = controller.getStatus();
            bot.chat(`位置: ${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}`);
            bot.chat(`状态: ${status.isNavigating ? '导航中' : '待机'}`);
            if (perception) {
                const visibleBlocks = perception.getVisibleBlocksArray();
                bot.chat(`可见方块数量: ${visibleBlocks.length}`);
            }
        }

        if (message === '!test') {
            // 测试寻路到附近的位置
            const pos = bot.entity.position;
            const testTarget = {
                x: pos.x + (Math.random() - 0.5) * 20,
                y: pos.y,
                z: pos.z + (Math.random() - 0.5) * 20
            };
            controller.navigateTo(testTarget);
            bot.chat(`测试导航到随机位置 ${testTarget.x.toFixed(1)}, ${testTarget.y.toFixed(1)}, ${testTarget.z.toFixed(1)}`);
        }

        if (message === '!near') {
            // 导航到最近的方块
            if (perception) {
                const visibleBlocks = perception.getVisibleBlocksArray();
                const groundBlocks = visibleBlocks.filter(block => 
                    block.type === 'grass_block' || block.type === 'dirt' || block.type === 'stone'
                );
                
                if (groundBlocks.length > 0) {
                    const targetBlock = groundBlocks[0]; // 最近的方块
                    const target = {
                        x: targetBlock.position.x,
                        y: targetBlock.position.y + 1,
                        z: targetBlock.position.z
                    };
                    controller.navigateTo(target);
                    bot.chat(`导航到最近的 ${targetBlock.type} 方块`);
                } else {
                    bot.chat('附近没有找到合适的方块');
                }
            } else {
                bot.chat('感知系统未初始化');
            }
        }

        if (message === '!debug') {
            // 调试信息
            const pos = bot.entity.position;
            const status = controller.getStatus();
            console.log('=== 调试信息 ===');
            console.log('Bot位置:', pos);
            console.log('导航状态:', status);
            if (perception) {
                const visibleBlocks = perception.getVisibleBlocksArray().slice(0, 5);
                console.log('可见方块(前5个):', visibleBlocks);
            }
            bot.chat('调试信息已输出到控制台');
        }
    });
}

function initializeIntelligentNavigation() {
    try {
        console.log('初始化自定义智能导航系统...');
        
        perception = new EnvironmentPerception(bot, 256); // 减少感知距离
        pathfinding = new RealTimePathfinding(bot, perception);
        controller.setPathfinding(pathfinding);
        
        console.log('自定义智能导航系统初始化成功');
        bot.chat('自定义智能导航系统已就绪！');
        bot.chat('指令: !goto x y z (导航), !test (随机测试), !near (最近方块)');
        bot.chat('指令: !stop (停止), !status (状态), !debug (调试)');
        
        // 定期更新感知信息
        setInterval(async () => {
            if (perception) {
                const visibleBlocks = await perception.updatePerceptionAsync();
                if (visibleBlocks.length > 0 && Math.random() < 0.1) { // 10%概率输出日志
                    console.log(`感知更新，可见方块: ${visibleBlocks.length}`);
                }
            }
        }, 1000);
        
        // 性能监控
        let lastMemoryCheck = Date.now();
        setInterval(() => {
            const now = Date.now();
            if (now - lastMemoryCheck > 30000) { // 30秒检查一次
                const memUsage = process.memoryUsage();
                console.log(`内存使用: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`);
                lastMemoryCheck = now;
            }
        }, 5000);
        
    } catch (error) {
        console.error('自定义智能导航系统初始化失败:', error);
        bot.chat('智能导航系统初始化失败');
    }
}

function initializeVisualization() {
    try {
        visualizationServer = new VisualizationServer(bot, perception, controller, 3008);
        console.log('可视化服务器初始化成功');
        console.log('请访问 http://localhost:3009 查看可视化界面');
        bot.chat('可视化界面已启动: http://localhost:3009');
    } catch (error) {
        console.error('可视化服务器初始化失败:', error);
    }
}

// ===== 启动与初始化 =====
bot.once('spawn', () => {
    console.log('Bot已生成，开始初始化自定义寻路系统...');
    
    welcome();
    setCreativeMode();
    
    // 启动可视化服务
    try {
        mineflayerViewer(bot, { port: 3007, firstPerson: false });
        console.log('Minecraft可视化服务已启动: http://localhost:3007');
    } catch (error) {
        console.error('启动Minecraft可视化失败:', error);
    }
    
    setupPathDrawing();
    registerCommands(bot, controller, parser);
    setupCustomChatEvent();
    setupOtherChatEvents();
    
    // 等待2秒后初始化智能导航系统
    setTimeout(() => {
        initializeIntelligentNavigation();
        
        // 再等待1秒后启动可视化服务器
        setTimeout(() => {
            initializeVisualization();
        }, 1000);
    }, 2000);
});

bot.on('error', (err) => {
    console.error('Bot错误:', err);
    
    // 尝试重连
    console.log('尝试在5秒后重连...');
    setTimeout(() => {
        console.log('正在重新连接到Minecraft服务器...');
        // 这里可以添加重连逻辑
    }, 5000);
});

bot.on('end', () => {
    console.log('Bot连接已断开');
    if (visualizationServer) {
        visualizationServer.stop();
    }
});

bot.on('kicked', (reason, loggedIn) => {
    console.log('Bot被踢出:', reason);
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('正在关闭应用...');
    if (visualizationServer) {
        visualizationServer.stop();
    }
    bot.end();
    process.exit(0);
});

console.log('正在连接到Minecraft服务器...');
console.log('自定义寻路版本启动中...');
console.log('===============================');
console.log('指令说明:');
console.log('!goto x y z  - 导航到指定坐标');
console.log('!test        - 随机位置测试');
console.log('!near        - 导航到最近方块');
console.log('!stop        - 停止导航');
console.log('!status      - 查看状态');
console.log('!debug       - 调试信息');
console.log('===============================');
