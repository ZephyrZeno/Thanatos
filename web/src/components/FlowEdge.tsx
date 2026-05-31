import { BaseEdge, type EdgeProps, getStraightPath } from '@xyflow/react';

export interface FlowEdgeData extends Record<string, unknown> {
  color: string;
  active: boolean;
  kind: 'structural' | 'dep' | 'collab' | 'collabPast';
  dimmed: boolean;
}

export function FlowEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY } = props;
  const data = (props.data ?? {}) as FlowEdgeData;
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  const isDep = data.kind === 'dep';
  const isCollab = data.kind === 'collab' || data.kind === 'collabPast';
  const baseColor = isDep ? '#f59e0b' : isCollab ? '#22c3a6' : data.color;
  const opacity = data.dimmed ? 0.12 : data.active ? 0.95 : data.kind === 'collabPast' ? 0.24 : isDep ? 0.7 : 0.3;

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        style={{
          stroke: baseColor,
          strokeWidth: data.active ? 2.4 : isCollab ? 1.6 : isDep ? 1.4 : 1.1,
          strokeDasharray: isDep ? '5 5' : isCollab ? '2 7' : undefined,
          opacity,
        }}
        markerEnd={props.markerEnd}
      />
      {data.active && !data.dimmed && (
        <circle r={3.6} fill={baseColor} style={{ filter: `drop-shadow(0 0 4px ${baseColor})` }}>
          <animateMotion dur={isDep ? '1.4s' : isCollab ? '1.8s' : '1.05s'} repeatCount="indefinite" path={path} />
        </circle>
      )}
    </>
  );
}
