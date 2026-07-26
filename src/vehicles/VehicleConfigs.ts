import * as THREE from 'three';
import type { VehicleId } from '../world/Vehicles';

/**
 * Driving balance, one object per vehicle.
 *
 * The model is arcade, not simulation: a single forward speed scalar, a
 * bicycle-model yaw rate for the wheeled vehicles and a skid-steer yaw rate for
 * the tracked one. That is deliberate — it stays predictable on a keyboard, it
 * never needs a solver, and every number here is something you can feel.
 */
export interface VehicleConfig {
  id: VehicleId;
  name: string;
  /** Forward top speed, m/s. */
  maxSpeed: number;
  /** Reverse top speed, m/s. */
  maxReverse: number;
  /** Engine acceleration at full throttle, m/s². */
  accel: number;
  /** Braking deceleration, m/s². */
  brake: number;
  /** Aerodynamic drag as a fraction of speed per second. */
  drag: number;
  /** Rolling resistance, m/s², applied whenever off throttle. */
  rollingResistance: number;
  /** Maximum steering angle at a standstill, radians. */
  maxSteer: number;
  /** How fast the steering angle chases its target, rad/s. */
  steerRate: number;
  /** Steering authority decays with speed: angle /= 1 + speed * this. */
  steerFalloff: number;
  /** Axle separation, metres — sets how sharply the bicycle model turns. */
  wheelbase: number;
  /** Skid-steer instead of steered wheels; can pivot on the spot. */
  tracked: boolean;
  /** Yaw rate at full lock for a tracked vehicle, rad/s. */
  turnRate: number;
  /** Half extents of the driving collision box. */
  half: THREE.Vector3;
  /** Height of that box's centre above the wheel contact plane. */
  centreY: number;
  /** How much grip is lost with the handbrake on, 0..1. */
  handbrakeSlip: number;
  /** Visual body lean, radians per unit of longitudinal / lateral load. */
  bodyPitchGain: number;
  bodyRollGain: number;
  gears: number;
  engine: { idle: number; redline: number; timbre: 'v12' | 'petrol' | 'diesel' };
  /** Walking mech only: stride, torso twist and armament. */
  mech?: {
    /** Metres of travel per full two-step stride. */
    strideLength: number;
    /** How far the hip swings at full stride, radians. */
    hipSwing: number;
    /** Extra knee bend through the swing phase, radians. */
    kneeBend: number;
    /** Vertical body bob per footfall, metres. */
    bob: number;
    /** How far the torso may twist off the chassis heading, radians. */
    torsoTwist: number;
    /** Torso traverse and gun elevation rates, rad/s. */
    twistRate: number;
    elevateRate: number;
    /** Arm cannons: hitscan, alternating between the four barrels. */
    cannon: { rpm: number; damage: number; spread: number; range: number };
    /** Shoulder missile pods. */
    barrage: {
      count: number;
      damage: number;
      blastRadius: number;
      cooldown: number;
      speed: number;
      spread: number;
    };
  };

  /** Tank only. */
  cannon?: {
    /** Muzzle velocity, m/s. */
    speed: number;
    damage: number;
    blastRadius: number;
    /** Seconds between rounds. */
    reload: number;
    /** Recoil pushed back into the hull, m/s. */
    recoil: number;
  };
}

export const VEHICLE_CONFIGS: Record<VehicleId, VehicleConfig> = {
  supercar: {
    id: 'supercar',
    name: 'MERIDIAN GT-9',
    maxSpeed: 82,
    maxReverse: 12,
    accel: 15,
    brake: 24,
    drag: 0.022,
    rollingResistance: 2.2,
    maxSteer: 0.5,
    steerRate: 4.2,
    steerFalloff: 0.055,
    wheelbase: 2.77,
    tracked: false,
    turnRate: 0,
    half: new THREE.Vector3(1.0, 0.6, 2.4),
    centreY: 0.6,
    handbrakeSlip: 0.85,
    bodyPitchGain: 0.010,
    bodyRollGain: 0.055,
    gears: 7,
    engine: { idle: 900, redline: 8600, timbre: 'v12' },
  },
  jeep: {
    id: 'jeep',
    name: 'FIELD ROVER 4X4',
    maxSpeed: 33,
    maxReverse: 10,
    accel: 7.5,
    brake: 15,
    drag: 0.05,
    rollingResistance: 3.0,
    maxSteer: 0.62,
    steerRate: 3.4,
    steerFalloff: 0.04,
    wheelbase: 2.64,
    tracked: false,
    turnRate: 0,
    half: new THREE.Vector3(0.98, 0.95, 2.2),
    centreY: 0.95,
    handbrakeSlip: 0.7,
    bodyPitchGain: 0.026,
    bodyRollGain: 0.11,
    gears: 5,
    engine: { idle: 750, redline: 5200, timbre: 'petrol' },
  },
  tank: {
    id: 'tank',
    name: 'M-77 WARDEN',
    maxSpeed: 19,
    maxReverse: 8,
    accel: 3.8,
    brake: 7,
    drag: 0.06,
    rollingResistance: 4.5,
    maxSteer: 0,
    steerRate: 3,
    steerFalloff: 0,
    wheelbase: 4.4,
    tracked: true,
    turnRate: 0.62,
    half: new THREE.Vector3(2.1, 1.1, 3.6),
    centreY: 1.1,
    handbrakeSlip: 0.2,
    bodyPitchGain: 0.020,
    bodyRollGain: 0.03,
    gears: 4,
    engine: { idle: 620, redline: 2600, timbre: 'diesel' },
    cannon: {
      speed: 175,
      damage: 260,
      blastRadius: 11,
      reload: 4.2,
      recoil: 1.6,
    },
  },
  thor: {
    id: 'thor',
    name: 'THOR ASSAULT MECH',
    // Deliberately ponderous: a nine-metre machine that accelerates like a car
    // reads as weightless, whatever the model looks like.
    maxSpeed: 7.5,
    maxReverse: 3.6,
    accel: 3.2,
    brake: 6,
    drag: 0.08,
    rollingResistance: 5.0,
    maxSteer: 0,
    steerRate: 3,
    steerFalloff: 0,
    wheelbase: 3,
    tracked: true,
    turnRate: 0.85,
    half: new THREE.Vector3(1.9, 2.2, 1.9),
    centreY: 2.2,
    handbrakeSlip: 0,
    bodyPitchGain: 0.012,
    bodyRollGain: 0.02,
    gears: 1,
    engine: { idle: 400, redline: 1400, timbre: 'diesel' },
    mech: {
      strideLength: 6.4,
      hipSwing: 0.42,
      kneeBend: 0.72,
      bob: 0.2,
      torsoTwist: 1.9,
      twistRate: 2.2,
      elevateRate: 1.5,
      cannon: { rpm: 260, damage: 26, spread: 0.55, range: 220 },
      barrage: { count: 6, damage: 70, blastRadius: 7, cooldown: 6, speed: 55, spread: 0.06 },
    },
  },
};

/** Turret traverse and gun elevation limits, radians. */
export const TURRET_TRAVERSE_RATE = 0.8;
export const TURRET_ELEVATION_RATE = 0.5;
export const GUN_MIN_PITCH = -0.14;
export const GUN_MAX_PITCH = 0.35;
