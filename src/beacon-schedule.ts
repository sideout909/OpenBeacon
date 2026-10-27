/** SmartBeaconing timing and corner trigger. Speeds are mph, times seconds, angles degrees. */
export interface SmartBeaconSettings {
  slowSpeed: number;
  fastSpeed: number;
  slowInterval: number;
  fastInterval: number;
  minTurnAngle: number;
  turnSlope: number;
  minTurnTime: number;
}
export function smartBeaconDecision(
  settings: SmartBeaconSettings,
  speed: number,
  course: number,
  lastCourse: number,
  elapsed: number,
): boolean {
  const {
    slowSpeed,
    fastSpeed,
    slowInterval,
    fastInterval,
    minTurnAngle,
    turnSlope,
    minTurnTime,
  } = settings;
  if (
    ![
      slowSpeed,
      fastSpeed,
      slowInterval,
      fastInterval,
      minTurnAngle,
      turnSlope,
      minTurnTime,
      speed,
      course,
      lastCourse,
      elapsed,
    ].every(Number.isFinite) ||
    slowSpeed < 0 ||
    fastSpeed <= slowSpeed ||
    fastInterval <= 0 ||
    slowInterval < fastInterval ||
    minTurnAngle < 0 ||
    minTurnAngle > 180 ||
    turnSlope < 0 ||
    minTurnTime < 0 ||
    speed < 0 ||
    elapsed < 0 ||
    course < 0 ||
    course >= 360 ||
    lastCourse < 0 ||
    lastCourse >= 360
  )
    return false;
  const interval =
    speed <= slowSpeed
      ? slowInterval
      : speed >= fastSpeed
        ? fastInterval
        : Math.min(slowInterval, (fastInterval * fastSpeed) / speed);
  const difference = Math.abs(course - lastCourse);
  const turn = Math.min(difference, 360 - difference);
  return (
    elapsed >= interval ||
    (speed > slowSpeed &&
      elapsed >= minTurnTime &&
      turn >= minTurnAngle + turnSlope / speed)
  );
}
