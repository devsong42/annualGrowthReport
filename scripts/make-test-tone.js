#!/usr/bin/env node
// 生成一段测试音乐，用来验证「背景音乐」播放链路（C-Am-F-G 琶音循环，8 秒）
// 用法：node scripts/make-test-tone.js [输出路径]   默认 static/music/2021001.wav
const fs = require('fs');
const path = require('path');

const target = process.argv[2] || path.join(__dirname, '..', 'static', 'music', '2021001.wav');

const sampleRate = 22050;
const noteSeconds = 0.25;
const progression = [
  [523.25, 659.25, 783.99], // C5 E5 G5
  [440.0, 523.25, 659.25], // A4 C5 E5
  [349.23, 440.0, 523.25], // F4 A4 C5
  [392.0, 493.88, 587.33], // G4 B4 D5
];
const pattern = [0, 1, 2, 1]; // 每个和弦弹成 上行-回落
const roundSeconds = progression.length * pattern.length * noteSeconds;
const totalSamples = Math.floor(sampleRate * roundSeconds * 2); // 循环两遍
const samples = new Float64Array(totalSamples);

for (let round = 0; round < 2; round += 1) {
  progression.forEach((chord, chordIndex) => {
    pattern.forEach((toneIndex, step) => {
      const freq = chord[toneIndex];
      const startAt = (round * progression.length + chordIndex) * pattern.length + step;
      const start = Math.floor(startAt * noteSeconds * sampleRate);
      const length = Math.floor(noteSeconds * sampleRate);
      for (let i = 0; i < length && start + i < totalSamples; i += 1) {
        const t = i / sampleRate;
        const attack = Math.min(1, i / (sampleRate * 0.008));
        const decay = Math.exp((-4 * t) / noteSeconds);
        const wave = Math.sin(2 * Math.PI * freq * t) * 0.7 + Math.sin(2 * Math.PI * freq * 2 * t) * 0.18;
        samples[start + i] += wave * attack * decay * 11000;
      }
    });
  });
}

const data = Buffer.alloc(samples.length * 2);
samples.forEach((value, index) => {
  const clamped = Math.max(-32768, Math.min(32767, Math.round(value)));
  data.writeInt16LE(clamped, index * 2);
});

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // 单声道
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, Buffer.concat([header, data]));
console.log(`已生成测试音乐：${target}`);
console.log(`  时长 ${(totalSamples / sampleRate).toFixed(1)} 秒（循环两遍 C-Am-F-G 琶音），16bit 单声道 ${sampleRate}Hz`);
console.log('  换成真实音乐时删掉它，或放一首同名的 mp3（mp3 优先级更高，会自动盖过它）');
