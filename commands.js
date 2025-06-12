// commands.js
// 注册开发调试指令
const Vec3 = require('vec3').Vec3;

module.exports = function registerCommands(bot, controller, parser) {
    let isFlying = false;

    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      const result = parser.parse(message);
      if (!result) return;
      
      switch (result.command) {
        case 'move':
          if (result.args[0] === 'stop') {
            controller.stop();
            if (isFlying) {
              bot.creative.stopFlying();
              isFlying = false;
            }
          } else if (result.args[0] === 'up') {
            if (!isFlying) {
              bot.creative.startFlying();
              isFlying = true;
            }
            const pos = bot.entity.position.offset(10, 5, 0);
            bot.creative.flyTo(pos);
            console.log("Flying up...");
          } else if (result.args[0] === 'down') {
            if (!isFlying) {
              bot.creative.startFlying();
              isFlying = true;
            }
            const pos = bot.entity.position.offset(0, -5, 0);
            bot.creative.flyTo(pos);
            console.log("Flying down...");
          } else if (result.args[0] === 'hover') {
            if (!isFlying) {
              bot.creative.startFlying();
              isFlying = true;
            }
            const pos = bot.entity.position;
            bot.creative.flyTo(pos);
            console.log("Hovering...");
          } else if (result.args[0] === 'land') {
            if (isFlying) {
              bot.creative.stopFlying();
              isFlying = false;
            }
            console.log("Landing...");
          } else {
            controller.move(result.args[0]);
          }
          break;
        case 'moveTo':
          const x = parseFloat(result.args[0]);
          const y = parseFloat(result.args[1]);
          const z = parseFloat(result.args[2]);
          
          if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
            const targetPos = new Vec3(x, y, z);
            if (isFlying) {
              // 如果在飞行状态，使用flyTo
              bot.creative.flyTo(targetPos);
              console.log(`Flying to position: ${x}, ${y}, ${z}`);
            } else {
              // 如果不在飞行状态，使用普通移动
              controller.moveTo(x, y, z);
            }
          } else {
            console.log("Invalid coordinates for moveTo command");
          }
          break;
        case 'turn':
          controller.turn(result.args[0]);
          break;
        default:
          break;
      }
    });
  };
  