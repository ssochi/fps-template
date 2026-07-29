/**
 * The helicopter, as geometry.
 *
 * Procedural like everything else, and deliberately crude: at this camera angle
 * and nineteen metres up it is a silhouette against the sky, and what has to
 * read is *a helicopter, over there, coming this way*. Detail spent on the
 * airframe would be detail nobody sees.
 *
 * The two things that do read at this size are the rotor disc and the
 * searchlight, so those get the work. The light is a cone drawn downward from
 * the fuselage — not an actual light, because one more shadow-casting spot for a
 * set piece that lasts eight minutes is not a trade worth making, and an unlit
 * cone of pale geometry reads as a searchlight perfectly well at dusk.
 */
import {
  BoxGeometry,
  CylinderGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
} from 'three';
import { HELI_ALTITUDE } from '../sim/Meta.js';

export class HelicopterMesh {
  constructor() {
    this.group = new Group();
    this.group.name = 'helicopter';
    this.group.visible = false;

    const body = new MeshLambertMaterial({ color: 0x2b3138 });
    const dark = new MeshLambertMaterial({ color: 0x191d21 });

    const fuselage = new Mesh(new BoxGeometry(1.5, 1.3, 3.6), body);
    fuselage.castShadow = true;
    this.group.add(fuselage);

    const tail = new Mesh(new BoxGeometry(0.45, 0.45, 3.2), body);
    tail.position.z = 3.2;
    this.group.add(tail);

    const fin = new Mesh(new BoxGeometry(0.18, 1.2, 0.8), body);
    fin.position.set(0, 0.7, 4.5);
    this.group.add(fin);

    for (const side of [-1, 1]) {
      const skid = new Mesh(new BoxGeometry(0.14, 0.14, 3.0), dark);
      skid.position.set(side * 0.7, -0.95, 0.1);
      this.group.add(skid);
    }

    // The rotor is a thin disc rather than blades: at any real rotation speed
    // that is what a rotor looks like, and it costs one draw instead of four.
    this.rotor = new Mesh(new CylinderGeometry(4.2, 4.2, 0.05, 20), new MeshBasicMaterial({
      color: 0x11151a,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    }));
    this.rotor.position.y = 1.05;
    this.group.add(this.rotor);

    const tailRotor = new Mesh(new CylinderGeometry(0.8, 0.8, 0.04, 12), new MeshBasicMaterial({
      color: 0x11151a, transparent: true, opacity: 0.45, depthWrite: false,
    }));
    tailRotor.rotation.z = Math.PI / 2;
    tailRotor.position.set(0.3, 0.5, 4.6);
    this.tailRotor = tailRotor;
    this.group.add(tailRotor);

    // The searchlight. Its whole job is to say "it has seen you", so it is off
    // until it has.
    this.beamMaterial = new MeshBasicMaterial({
      color: 0xffe9b8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const beam = new Mesh(new ConeGeometry(3.4, HELI_ALTITUDE, 16, 1, true), this.beamMaterial);
    beam.position.y = -HELI_ALTITUDE / 2 - 0.6;
    beam.renderOrder = 3;
    this.beam = beam;
    this.group.add(beam);
  }

  /** @param {import('../sim/Meta.js').Helicopter} heli */
  sync(heli) {
    this.group.visible = heli.active;
    if (!heli.active) return;

    this.group.position.set(heli.x, HELI_ALTITUDE, heli.z);
    // Nose toward where it is heading, so a machine circling a spot visibly
    // circles it.
    const dx = heli.targetX - heli.x;
    const dz = heli.targetZ - heli.z;
    if (dx * dx + dz * dz > 0.25) this.group.rotation.y = Math.atan2(-dx, -dz);

    this.rotor.rotation.y = heli.spin;
    this.tailRotor.rotation.x = heli.spin * 2.4;
    // Eased so the beam comes up rather than snapping on.
    const target = heli.sighted ? 0.2 : 0;
    this.beamMaterial.opacity += (target - this.beamMaterial.opacity) * 0.08;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    this.group.removeFromParent();
  }
}
