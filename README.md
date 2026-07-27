# Creature Forge

A procedural 3D creature generator: **Three.js + TypeScript + Vite**, cel shaded, with no keyframes and
no binary assets. Creatures are described by a genome, grown from it, animated by solvers rather than
clips, and can be mutated, bred and extended with new body parts.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production bundle
```

---

## The three requirements, and how each is met

### Mutable

Every heritable quantity is a bounded number with a declared range in a **trait table**:

```ts
export const BODY_TRAITS: TraitTable = {
  segments: { min: 4, max: 14, label: 'Spine segments', integer: true },
  length:   { min: 0.9, max: 4.2, label: 'Body length' },
  girth:    { min: 0.085, max: 0.3, label: 'Girth' },
  // ...
};
```

Mutation, crossover, randomisation and the UI sliders are all **generic over these tables**. None of
them names a field. Add a trait to a table and it mutates, breeds and gets a correctly-ranged,
correctly-labelled slider without another line of code.

Two things that took tuning rather than thought:

- Mutation strength has a floor and a ceiling that both look like failure. Too timid and every child is
  indistinguishable from its parent; too violent and it is indistinguishable from a random creature.
  `amount` scales a per-trait volatility, only ~55% of traits move on any given mutation, and
  **structural** changes — gaining, losing and duplicating whole parts — roll separately and much more
  rarely, because those are the changes people actually notice.
- Crossover blends numbers but **inherits parts whole**, since there is no such thing as half a wing.
  Attachments are matched between parents by kind and position, so one parent's front legs cross with
  the other's front legs rather than with its horns.

### Diverse

Independent uniform draws over every trait do not give variety — they give the *middle* of the space,
over and over. The shapes worth seeing need several traits at their extremes simultaneously: a snake is
long **and** many-segmented **and** legless **and** high spine-flex, and the chance of drawing all four
together is negligible. Measured before body plans existed, nearly every creature came out a medium tube
on four medium legs.

So randomisation goes through an **archetype** — quadruped, insectoid, serpent, arachnid, biped, flier,
blob — which narrows the ranges and says how many legs go where. An archetype is a *prior*, not a new
representation: everything it produces is an ordinary genome, and nothing downstream knows archetypes
exist. A bred creature has no archetype at all, only the genes it inherited. Ranges are expressed as
fractions of each trait's declared range, so retuning a trait's bounds cannot silently invalidate every
archetype that mentioned it.

Markings are five hard-edged patterns — bands, spots, patches, segments, plain — plus independent
countershading, all driven from two coordinates: the shared spine parameter and the angle around each
part. That pairing is what lets one stripe wrap the body, the legs and the tail as a single pattern,
with no UV unwrap of geometry that did not exist a frame ago.

Surface **relief** — segmentation rings, dorsal scutes, longitudinal ridges — is a radius multiplier
applied as the body tube is rewritten each frame. It costs two trig calls per vertex, needs no
displacement map, and `computeVertexNormals` picks it up so it lights as real relief rather than as a
painted-on pattern. It is most of the difference between a body that reads as an animal and one that
reads as a balloon.

### Composable

A creature does not have a head field and a legs field. It has a list of **attachments**:

```ts
interface Attachment {
  kind: string;                    // registry key: 'leg', 'horn', 'wing', …
  at: number;                      // 0 at the tail tip, 1 at the nose
  symmetry: 'pair' | 'single';     // mirrored, or on the centreline
  around: number;                  // 0 under the belly, ±pi/2 at the sides, ±pi on the back
  scale: number;
  traits: Record<string, number>;  // validated against the part's own schema
}
```

`at` is a position along the spine rather than a segment index, so a genome stays valid when a mutation
changes the segment count under it. Any part can go anywhere a part can go, which is what makes
crossover meaningful.

### Extensible

Adding a body part is one registration. This is the whole of it:

```ts
registerPart({
  kind: 'horn',
  label: 'Horn',
  group: 'crest',
  maxCount: 8,
  weight: 4,
  traits: {
    length:    { min: 0.3, max: 3.2, label: 'Horn length' },
    thickness: { min: 0.1, max: 0.7, label: 'Horn thickness' },
    curve:     { min: -0.7, max: 0.9, label: 'Horn curve' },
  },
  defaultPlacement: (rng) => ({ at: rng.range(0.75, 0.96), symmetry: 'pair', around: Math.PI, scale: 1 }),
  build: (ctx) => { /* build into ctx.socket */ },
});
```

From that moment the randomiser can pick it, mutation can add, remove, duplicate and retune it,
breeding inherits it, the panel grows sliders for it, and the animator drives whatever rigs it returns.
Nothing in the genome, the mutator, the animator or the UI knows the part exists.

The contract a part must keep is short, and all three clauses exist because breaking them fails quietly:

1. **Build into `ctx.socket` and nowhere else.** The socket is already positioned, oriented and
   mirrored; a part that reaches for world coordinates is wrong on the left-hand side of every creature.
2. **Bones run down local `-Y`,** with the child joint at `(0, -length, 0)`. Every solver assumes it.
3. **Return the rigs you want animated.** Returning nothing is fine — a horn is a perfectly good part.

Twelve kinds ship: leg, head, tail, antenna, horn, fin, armour plate, wing, eye stalk, frill, shell,
pincer.

---

## Procedural animation

There are no clips, no keyframes and no baked cycles. Every pose is solved from current state.

**The gait is not authored, it is a consequence.** Feet are planted in the world and stay planted; when
the body carries a foot too far from where that foot ought to be, it takes a step. One extra constraint
— a leg may only lift if no leg in the opposite phase group is already in the air — turns a pile of
independent legs into a gait. The diagonal pairs of a quadruped and the tripod of a hexapod are *the
same rule*; neither is written down. A creature with five legs, or with one leg shorter than the rest,
is not a special case, which is the entire point when the creature was assembled by mutation.

**The stride clock runs on distance, not time.** Tie a walk cycle to a timer and the feet skate the
moment the speed changes. Tie it to metres travelled and they cannot, by construction.

Layered on top:

- **Two-bone IK**, solved analytically by the law of cosines. Iterative solvers are the usual reach and
  the wrong tool at two bones: this is constant-time, has nothing to converge, and does not jitter at
  the edge of reach. The **pole vector is not optional** — aligning a bone to a target leaves the roll
  about that axis free, and letting an arbitrary perpendicular decide it is the difference between a
  leg and a broken leg.
- **A travelling spine wave**, phase-offset per joint so the body snakes rather than wagging as one plank.
- **Spring chains** for tails, antennae and eye stalks. Each joint aims at where the next joint's spring
  has *drifted* to, and the lag is the whole effect — a tail that tracks perfectly is a broom handle.
- **Head look-at** with anticipation, so the head leads a turn instead of being dragged through it.
- Breathing, jaw idle, wing beats, turn lean.

---

## Cel shading

Built on `MeshToonMaterial` rather than a raw `ShaderMaterial`. Writing the shader from scratch is the
obvious route and throws away the entire lighting pipeline with it — shadow maps, fog, light probes and
colour management all live in three.js's chunk system, and a hand-rolled shader has to reimplement every
one to look right. The cel look is a `gradientMap` with `NearestFilter`; everything else is injected at
named chunk boundaries (`color_fragment` for the bands, `opaque_fragment` for the rim).

Three additions, because stock toon shading alone reads as flat vinyl: a **quantised rim light** (a
smooth rim on a cel surface reads as a bloom artefact; a hard edge reads as drawn), **bands** driven by
a per-vertex spine coordinate so a stripe wraps the body, the legs and the tail as one pattern, and a
**shade bias** that slides the terminator.

Outlines are **inverted hulls** rather than a post-process edge detector, because a creature is dozens of
separate meshes: a screen-space pass finds the silhouette of the whole animal, while a hull gives every
limb, horn and toe its own line.

Tone mapping is off. ACES rolls highlights off smoothly, which is exactly what a cel ramp exists to
prevent — it turns the hard step between bands back into a gradient.

---

## Things that were measured rather than eyeballed

Four bugs here were invisible to inspection and obvious to a script. All four checks are worth keeping.

**Inside-out geometry.** The body tube and every spike wound their triangles the readable way, which put
168 of 192 face normals inward. The result was not a subtle shading error — every creature rendered with
a jet-black body lit from within, with correctly shaded limbs attached to it. A twelve-line node script
comparing face normals against the outward radial direction found it in seconds and confirmed the fix at
0 inward faces.

**The IK solver.** Swept across 1694 reachable targets: worst foot error 0.000000, zero pole violations,
out-of-reach targets stretching to exactly maximum reach without flipping or producing NaN.

**Creatures that would not stand.** By eye, "some of them look a bit low". Measured, **23 of 24 random
creatures had feet off the ground**, some by half a metre. The cause was a circular dependency: leg
length came out of the gap between socket and ground, which came out of the ride height, which came out
of leg length. On a wide body the residual gap collapsed and the creature grew centimetre-long legs.
Leg length is a gene now, resolved in two passes with no loop — 24/24 trunks clear the floor and 21/24
stand with every foot planted.

**Z-fighting and shadow acne.** The outline hull expanded in clip space, leaving it at exactly the
surface's depth, so anywhere the geometry was thin the two coincided and speckled. Expanding along the
view-space normal instead pushes a back face away from the camera, where it belongs.

**Creatures walking off the world.** Over six simulated minutes each, five of eight left the
thirty-metre ground entirely; the worst reached 550 m and was still going. The containment steering had
two faults, and the second is the instructive one: it was written `lerp(desiredHeading, inward, t)`, but
`desiredHeading` is an unbounded running sum while `inward` comes from `atan2` and lives in (-pi, pi].
Interpolating a raw number toward a wrapped one is not a turn toward anything — once the sum had
drifted a few turns from zero the "correction" pointed somewhere arbitrary, often outward. Angles need
`angleDelta`. Measured after: 0/8 leave an 11.5 m pen, max distance 8.7-10.5 m.

---

## Layout

```
src/
├── main.ts                     Entry point + WebGL capability check
├── core/
│   ├── App.ts                  Orchestrator; genome is the single source of truth
│   ├── Stage.ts                Renderer, camera, lights, ground, framing
│   ├── Rng.ts                  Seeded PRNG, seed <-> shareable code
│   └── MathUtils.ts            damp, springs, value noise
├── genome/
│   ├── Genome.ts               The data model + trait tables + repair-on-load
│   ├── Archetypes.ts           Body plans: priors over the same genome
│   └── Mutate.ts               Randomise, mutate, breed — all generic over traits
├── build/
│   ├── CreatureBuilder.ts      Genome -> rig + meshes
│   ├── PartRegistry.ts         The extension point
│   ├── Body.ts                 Spine chain + tube deformed from joint transforms
│   ├── Shapes.ts               Generated primitives
│   └── parts/                  Limbs, Heads, Appendages
├── anim/
│   ├── Animator.ts             Steering, gait, spine wave, chains, look-at
│   ├── IK.ts                   Analytic two-bone solver
│   └── Rig.ts                  What a part hands back to be animated
├── shading/
│   └── Toon.ts                 Cel ramp, bands, rim, outlines, palette
└── ui/
    ├── Panel.ts                Controls, generated from the trait tables
    └── styles.css
```

## Using it

- **Randomise / Mutate / Breed** — save creatures to the gallery, pick one as a mate, cross them.
- **Re-seed** keeps the genes and re-rolls the stochastic detail.
- Every creature has a **seed code** and the URL carries the full genome, so a link reproduces exactly.
- **Copy / Paste genome** moves creatures between browsers.
- Drag to orbit, scroll to zoom. The head tracks the camera.

## Known rough edges

- Proportions are good on most rolls but not all; extreme trait combinations still produce creatures
  that read as odd rather than as animals.
- Legless creatures slide rather than slither — the spine wave is there, but nothing converts it into
  forward thrust, so a serpent moves like a snake on ice.
- Feet do not conform to uneven ground — the world is flat, so the planting solver has no height query.
- Wings flap on a fixed cycle rather than being driven by anything.

## License

MIT — see [LICENSE](LICENSE).
