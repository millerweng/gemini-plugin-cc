import type {CSSProperties} from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {
  commands,
  reviewCardStart,
  statusSteps,
  type CommandStep,
} from './script';

const colors = {
  canvas: '#101214',
  terminal: '#07090b',
  chrome: '#1e2227',
  panel: '#0d1116',
  panelSoft: '#111821',
  border: '#2b323b',
  text: '#e7ecef',
  muted: '#8d98a5',
  faint: '#596573',
  cyan: '#75d7ff',
  green: '#5ee59b',
  amber: '#f5b85b',
  violet: '#b7a6ff',
  red: '#ff6d68',
};

const mono =
  '"SFMono-Regular", "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace';

const clamp = (
  frame: number,
  input: [number, number],
  output: [number, number],
) =>
  interpolate(frame, input, output, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

const commandSubmitFrame = (step: CommandStep) =>
  step.startFrame + step.typeFrames + 8;

const typedText = (text: string, frame: number, step: CommandStep) => {
  const progress = clamp(
    frame - step.startFrame,
    [0, step.typeFrames],
    [0, text.length],
  );
  return text.slice(0, Math.floor(progress));
};

const isTyping = (frame: number, step: CommandStep) =>
  frame >= step.startFrame && frame < step.startFrame + step.typeFrames;

export const OnboardingVideo = () => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={styles.canvas}>
      <div style={styles.backdrop} />
      <div style={styles.window}>
        <WindowChrome />
        <div style={styles.body}>
          <Terminal frame={frame} />
          <StatusRail frame={frame} />
        </div>
      </div>
    </AbsoluteFill>
  );
};

const WindowChrome = () => (
  <div style={styles.chrome}>
    <div style={styles.dots}>
      <span style={{...styles.dot, backgroundColor: colors.red}} />
      <span style={{...styles.dot, backgroundColor: colors.amber}} />
      <span style={{...styles.dot, backgroundColor: colors.green}} />
    </div>
    <div style={styles.title}>gemini-plugin-cc</div>
  </div>
);

const Terminal = ({frame}: {frame: number}) => (
  <div style={styles.terminal}>
    <div style={styles.terminalHeader}>
      <div>
        <span style={styles.headerLabel}>Claude Code</span>
        <span style={styles.headerText}> ~/GitHub/app</span>
      </div>
      <div style={styles.headerPill}>Gemini companion ready</div>
    </div>
    <div style={styles.rule} />
    <div style={styles.transcript}>
      {commands.map((step) => (
        <CommandBlock frame={frame} key={step.text} step={step} />
      ))}
    </div>
    <ReviewCard frame={frame} />
    {frame < reviewCardStart ? (
      <div style={styles.footer}>
        opus · high · plugin namespace /gemini:* · local ACP over stdio
      </div>
    ) : null}
  </div>
);

const CommandBlock = ({frame, step}: {frame: number; step: CommandStep}) => {
  if (frame < step.startFrame) {
    return null;
  }

  const submitted = frame >= commandSubmitFrame(step);
  const command = submitted ? step.text : typedText(step.text, frame, step);
  const commandOpacity = clamp(frame, [step.startFrame, step.startFrame + 8], [0, 1]);

  return (
    <div style={{...styles.commandBlock, opacity: commandOpacity}}>
      <div style={styles.commandLine}>
        <span style={styles.prompt}>&gt;</span>
        <span style={styles.command}>{command}</span>
        {isTyping(frame, step) ? <span style={styles.cursor} /> : null}
      </div>
      <div style={styles.outputGroup}>
        {step.output.map((line, index) => (
          <OutputLine
            frame={frame}
            key={line}
            line={line}
            startFrame={step.outputStartFrame + index * 8}
          />
        ))}
      </div>
    </div>
  );
};

const OutputLine = ({
  frame,
  line,
  startFrame,
}: {
  frame: number;
  line: string;
  startFrame: number;
}) => {
  if (frame < startFrame) {
    return null;
  }

  const opacity = clamp(frame, [startFrame, startFrame + 8], [0, 1]);
  const y = clamp(frame, [startFrame, startFrame + 8], [8, 0]);
  const isStatus = line.startsWith('Status:') || line.startsWith('Findings:');

  return (
    <div
      style={{
        ...styles.outputLine,
        color: isStatus ? colors.cyan : colors.text,
        opacity,
        transform: `translateY(${y}px)`,
      }}
    >
      <span style={styles.check}>ok</span>
      <span>{line}</span>
    </div>
  );
};

const StatusRail = ({frame}: {frame: number}) => (
  <div style={styles.statusRail}>
    <div style={styles.statusTitle}>Onboarding path</div>
    <div style={styles.statusList}>
      {statusSteps.map((step, index) => {
        const active =
          frame >= commands[index].startFrame && frame < step.doneFrame;
        const done = frame >= step.doneFrame;

        return (
          <div
            key={step.label}
            style={{
              ...styles.statusRow,
              ...(active ? styles.statusRowActive : {}),
            }}
          >
            <span
              style={{
                ...styles.statusDot,
                backgroundColor: done
                  ? colors.green
                  : active
                    ? colors.amber
                    : colors.faint,
              }}
            />
            <span style={{color: done || active ? colors.text : colors.muted}}>
              {step.label}
            </span>
            <span style={styles.statusState}>
              {done ? 'done' : active ? 'running' : 'queued'}
            </span>
          </div>
        );
      })}
    </div>
    <div style={styles.statusNote}>
      One plugin install. One Gemini CLI verify. One review loop.
    </div>
  </div>
);

const ReviewCard = ({frame}: {frame: number}) => {
  const opacity = clamp(frame, [reviewCardStart, reviewCardStart + 16], [0, 1]);
  const y = clamp(frame, [reviewCardStart, reviewCardStart + 16], [12, 0]);

  if (frame < reviewCardStart) {
    return null;
  }

  return (
    <div
      style={{
        ...styles.reviewCard,
        opacity,
        transform: `translateY(${y}px)`,
      }}
    >
      <div style={styles.reviewLabel}>Gemini review</div>
      <div style={styles.reviewMetrics}>
        <Metric label="blocking" value="0" />
        <Metric label="follow-ups" value="2" />
        <Metric label="result" value="saved" />
      </div>
    </div>
  );
};

const Metric = ({label, value}: {label: string; value: string}) => (
  <div style={styles.metric}>
    <span style={styles.metricValue}>{value}</span>
    <span style={styles.metricLabel}>{label}</span>
  </div>
);

const styles: Record<string, CSSProperties> = {
  canvas: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    color: colors.text,
    display: 'flex',
    fontFamily: mono,
    justifyContent: 'center',
    letterSpacing: 0,
    overflow: 'hidden',
  },
  backdrop: {
    background:
      'linear-gradient(135deg, #101214 0%, #17202a 46%, #0d1013 100%)',
    inset: 0,
    position: 'absolute',
  },
  window: {
    backgroundColor: colors.terminal,
    border: `1px solid ${colors.border}`,
    borderRadius: 14,
    boxShadow: '0 30px 80px rgba(0,0,0,0.42)',
    height: 460,
    overflow: 'hidden',
    position: 'relative',
    width: 860,
  },
  chrome: {
    alignItems: 'center',
    backgroundColor: colors.chrome,
    borderBottom: `1px solid ${colors.border}`,
    display: 'flex',
    height: 34,
    padding: '0 14px',
    position: 'relative',
  },
  dots: {
    display: 'flex',
    gap: 7,
  },
  dot: {
    borderRadius: 999,
    height: 10,
    width: 10,
  },
  title: {
    color: colors.muted,
    fontSize: 12,
    left: 0,
    position: 'absolute',
    right: 0,
    textAlign: 'center',
  },
  body: {
    display: 'grid',
    gridTemplateColumns: '1fr 220px',
    height: 426,
  },
  terminal: {
    boxSizing: 'border-box',
    height: '100%',
    overflow: 'hidden',
    padding: '18px 20px 14px',
    position: 'relative',
  },
  terminalHeader: {
    alignItems: 'center',
    display: 'flex',
    fontSize: 13,
    justifyContent: 'space-between',
    lineHeight: '18px',
  },
  headerLabel: {
    color: colors.violet,
    fontWeight: 800,
  },
  headerText: {
    color: colors.muted,
  },
  headerPill: {
    backgroundColor: 'rgba(117, 215, 255, 0.12)',
    border: `1px solid rgba(117, 215, 255, 0.26)`,
    borderRadius: 999,
    color: colors.cyan,
    fontSize: 11,
    padding: '4px 8px',
  },
  rule: {
    backgroundColor: colors.border,
    height: 1,
    margin: '12px 0 10px',
  },
  transcript: {
    display: 'flex',
    flexDirection: 'column',
    gap: 5,
    height: 292,
    overflow: 'hidden',
  },
  commandBlock: {
    minHeight: 0,
  },
  commandLine: {
    alignItems: 'center',
    display: 'flex',
    fontSize: 15,
    height: 22,
    lineHeight: '22px',
    whiteSpace: 'pre',
  },
  prompt: {
    color: colors.green,
    flex: '0 0 auto',
    fontWeight: 900,
    marginRight: 9,
  },
  command: {
    color: colors.text,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'clip',
  },
  cursor: {
    backgroundColor: colors.green,
    display: 'inline-block',
    height: 17,
    marginLeft: 4,
    transform: 'translateY(2px)',
    width: 8,
  },
  outputGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    marginLeft: 24,
  },
  outputLine: {
    alignItems: 'center',
    display: 'flex',
    fontSize: 12,
    height: 17,
    lineHeight: '17px',
    whiteSpace: 'pre',
  },
  check: {
    color: colors.green,
    fontSize: 10,
    fontWeight: 800,
    marginRight: 8,
    textTransform: 'uppercase',
  },
  reviewCard: {
    backgroundColor: colors.panel,
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    bottom: 18,
    boxSizing: 'border-box',
    display: 'flex',
    gap: 16,
    left: 20,
    padding: '10px 12px',
    position: 'absolute',
    right: 20,
  },
  reviewLabel: {
    color: colors.cyan,
    flex: '0 0 130px',
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: 0,
    textTransform: 'uppercase',
  },
  reviewMetrics: {
    display: 'flex',
    gap: 18,
  },
  metric: {
    alignItems: 'baseline',
    display: 'flex',
    gap: 6,
  },
  metricValue: {
    color: colors.text,
    fontSize: 15,
    fontWeight: 900,
  },
  metricLabel: {
    color: colors.muted,
    fontSize: 12,
  },
  footer: {
    bottom: 14,
    color: colors.faint,
    fontSize: 11,
    left: 20,
    overflow: 'hidden',
    position: 'absolute',
    right: 20,
    textOverflow: 'clip',
    whiteSpace: 'pre',
  },
  statusRail: {
    backgroundColor: colors.panelSoft,
    borderLeft: `1px solid ${colors.border}`,
    boxSizing: 'border-box',
    padding: '20px 16px',
  },
  statusTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: 900,
    marginBottom: 14,
  },
  statusList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  statusRow: {
    alignItems: 'center',
    border: `1px solid ${colors.border}`,
    borderRadius: 8,
    display: 'grid',
    fontSize: 11,
    gridTemplateColumns: '12px 1fr auto',
    minHeight: 34,
    padding: '0 8px',
  },
  statusRowActive: {
    backgroundColor: 'rgba(245, 184, 91, 0.09)',
    borderColor: 'rgba(245, 184, 91, 0.42)',
  },
  statusDot: {
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  statusState: {
    color: colors.muted,
    fontSize: 10,
    marginLeft: 8,
    textTransform: 'uppercase',
  },
  statusNote: {
    borderTop: `1px solid ${colors.border}`,
    color: colors.muted,
    fontSize: 11,
    lineHeight: '17px',
    marginTop: 18,
    paddingTop: 14,
  },
};
