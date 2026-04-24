export const fps = 20;
export const durationInFrames = 320;
export const dimensions = {
  width: 960,
  height: 540,
};

export type CommandStep = {
  text: string;
  startFrame: number;
  typeFrames: number;
  outputStartFrame: number;
  output: string[];
};

export const commands: CommandStep[] = [
  {
    text: '/plugin marketplace add m-ghalib/gemini-plugin-cc',
    startFrame: 24,
    typeFrames: 34,
    outputStartFrame: 72,
    output: ['marketplace added: m-ghalib/gemini-plugin-cc'],
  },
  {
    text: '/plugin install gemini@gemini-plugin-cc',
    startFrame: 86,
    typeFrames: 30,
    outputStartFrame: 128,
    output: ['installed: gemini 1.0.0'],
  },
  {
    text: '/reload-plugins',
    startFrame: 142,
    typeFrames: 14,
    outputStartFrame: 168,
    output: ['plugins reloaded'],
  },
  {
    text: '/gemini:setup --verify',
    startFrame: 182,
    typeFrames: 18,
    outputStartFrame: 212,
    output: [
      'Gemini CLI: @google/gemini-cli@0.38.2',
      'Auth: ready',
      'ACP handshake: ok',
    ],
  },
  {
    text: '/gemini:review --wait',
    startFrame: 240,
    typeFrames: 18,
    outputStartFrame: 270,
    output: [
      'Gemini review complete',
      'Findings: 0 blocking, 2 follow-ups',
      'Status: result saved for /gemini:result',
    ],
  },
];

export const statusSteps = [
  {label: 'Marketplace', doneFrame: commands[0].outputStartFrame + 10},
  {label: 'Plugin install', doneFrame: commands[1].outputStartFrame + 10},
  {label: 'Reload', doneFrame: commands[2].outputStartFrame + 10},
  {label: 'Verify', doneFrame: commands[3].outputStartFrame + 30},
  {label: 'Review', doneFrame: commands[4].outputStartFrame + 28},
];

export const reviewCardStart = commands[4].outputStartFrame + 24;
