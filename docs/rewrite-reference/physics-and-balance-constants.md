# Magic Constants Reference: OpenSoldat Physics & Balance

## Global Physics Constants

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **Gravity (sv_gravity)** | 0.06 | CVAR_SYNC | shared/Cvar.pas:985 | Base gravity, applied to sprites and other physics objects |
| **Gravity Multiplier (Sprites)** | 1.06 × GRAV | Hardcoded | shared/mechanics/Sprites.pas:327 | Skeleton gravity for player bodies |
| **Gravity Multiplier (Bullets)** | 2.25 × GRAV | Hardcoded | shared/Cvar.pas:231 | Bullets fall faster than players |
| **Gravity Multiplier (Sparks)** | GRAV / 1.4 | Hardcoded | shared/Cvar.pas:232 | Sparks fall slower |
| **Velocity Damping (RKV)** | 0.98 | Hardcoded | shared/Parts.pas:32 | Verlet integrator damping; velocity retention per timestep |
| **Sprite Skeleton VDamping** | 0.9945 | Hardcoded | shared/mechanics/Sprites.pas:329 | Per-frame velocity retention for player skeleton |
| **Time Step (Physics)** | 1 | Hardcoded | shared/mechanics/Sprites.pas:326 | Timestep for Verlet integration (normalized units) |

## Player Movement Constants

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **Run Speed** | 0.118 | Hardcoded | shared/Constants.pas:40 | Base walking/running speed |
| **Run Speed Up** | RUNSPEED / 6 ≈ 0.0197 | Hardcoded | shared/Constants.pas:41 | Acceleration while running |
| **Jump Speed** | 0.66 | Hardcoded | shared/Constants.pas:43 | Vertical velocity impulse for jump |
| **Crouch Run Speed** | RUNSPEED / 0.6 ≈ 0.197 | Hardcoded | shared/Constants.pas:44 | Speed while crouching and moving (faster than normal run) |
| **Prone Speed** | RUNSPEED × 4.0 = 0.472 | Hardcoded | shared/Constants.pas:45 | Speed while crawling prone |
| **Roll Speed** | RUNSPEED / 1.2 ≈ 0.0983 | Hardcoded | shared/Constants.pas:46 | Speed during tactical roll |
| **Jump Direction Speed** | 0.30 | Hardcoded | shared/Constants.pas:47 | Horizontal velocity during side jump |
| **Jetpack Speed (JETSPEED)** | 0.10 | Hardcoded | shared/Constants.pas:48 | Upward/lateral thrust per frame when jetpack active |
| **Max Velocity** | 11 | Hardcoded | shared/mechanics/Sprites.pas:51 | Terminal velocity magnitude cap |
| **Slide Limit** | 0.2 | Hardcoded | shared/mechanics/Sprites.pas:50 | Threshold for sliding collision |

## Surface Friction Coefficients

Applied when player is in motion on ground. Control.pas applies different coefficients based on player position (standing/crouching/prone).

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **Default Surface Friction X** | 0.970 | Hardcoded | shared/mechanics/Sprites.pas:24 | Horizontal friction (normal movement) |
| **Default Surface Friction Y** | 0.970 | Hardcoded | shared/mechanics/Sprites.pas:25 | Vertical friction (normal movement) |
| **Crouch Move Friction X** | 0.850 | Hardcoded | shared/mechanics/Sprites.pas:26 | Reduced friction while crouching/moving |
| **Crouch Move Friction Y** | 0.970 | Hardcoded | shared/mechanics/Sprites.pas:27 | No change to vertical friction while crouching |
| **Stand Surface Friction X** | 0.000 | Hardcoded | shared/mechanics/Sprites.pas:28 | No friction while standing still (allows sliding) |
| **Stand Surface Friction Y** | 0.000 | Hardcoded | shared/mechanics/Sprites.pas:29 | No friction while standing still |
| **Grenade Surface Friction** | 0.880 | Hardcoded | shared/mechanics/Sprites.pas:30 | Bouncing grenade friction |
| **Spark Surface Friction** | 0.700 | Hardcoded | shared/mechanics/Sprites.pas:31 | Spark particle friction |

## Bullet & Projectile Behavior

### Timeouts (Bullet Lifetimes)

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **BULLET_TIMEOUT** | 420 ticks (60 Hz = 7 sec) | Hardcoded | shared/Constants.pas:115 | Standard bullet lifetime |
| **GRENADE_TIMEOUT** | 180 ticks (60 Hz = 3 sec) | Hardcoded | shared/Constants.pas:116 | Frag/cluster grenade detonation time |
| **M2BULLET_TIMEOUT** | 60 ticks (60 Hz = 1 sec) | Hardcoded | shared/Constants.pas:117 | Stationary gun bullet lifetime |
| **FLAMER_TIMEOUT** | 32 ticks | Hardcoded | shared/Constants.pas:118 | Flame particle lifetime |
| **MELEE_TIMEOUT** | 1 tick | Hardcoded | shared/Constants.pas:119 | Knife/punch/melee damage application |

### Penetration & Degradation

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **Distance Degradation Threshold 1** | 500 units | Hardcoded | shared/mechanics/Bullets.pas:650 | First damage reduction at 500 units (HitMultiply × 0.5) |
| **Distance Degradation Threshold 2** | 900 units | Hardcoded | shared/mechanics/Bullets.pas:658 | Second damage reduction at 900 units (HitMultiply × 0.5 again) |
| **Bullet Degradation Check Interval** | Every 6 ticks (TimeOut mod 6) | Hardcoded | shared/mechanics/Bullets.pas:638 | Degradation checked once per ~100ms |
| **Ricochet Count** | Per-bullet tracking | Hardcoded | shared/mechanics/Bullets.pas:29, 198 | Ricochets are counted but max not enforced in shown code |

### Bullet Trail & Rendering

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **BULLETTRAIL** | 13 | Hardcoded | shared/Constants.pas:67 | Bullet trail length divisor for scaling |
| **M79TRAIL** | 6 | Hardcoded | shared/Constants.pas:68 | Grenade trail length divisor |
| **BULLETALPHA** | 110 | Hardcoded | shared/mechanics/Sprites.pas:47 | Default bullet alpha/transparency |
| **ARROW_RESIST** | 280 ticks | Hardcoded | shared/Constants.pas:131 | Arrow rendering trail threshold |

### Flame Mechanics

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **Flame Upward Force** | -0.15 | Hardcoded | shared/mechanics/Bullets.pas:725 | Negative Y force per frame (floats up) |
| **Flame Bullet Creation Offset** | +1 pos in X/Y | Hardcoded | shared/mechanics/Bullets.pas:224-225 | Flame bullets advance position on creation |

## Weapon Stat Tables (Guns[])

### Weapon Index/Num Mapping Quirks

Note: OpenSoldat uses scrambled field ordering (shared/Weapons.pas:15 comment) and has mismatched index/num mapping for secondary weapons.

| Gun Name | Array Index | Num Field | Notes |
|----------|-------------|-----------|-------|
| Desert Eagle | 1 | 1 | Primary weapons index matches num |
| HK MP5 | 2 | 2 | |
| AK-74 | 3 | 3 | |
| Steyr AUG | 4 | 4 | |
| SPAS-12 | 5 | 5 | |
| Ruger 77 | 6 | 6 | |
| M79 | 7 | 7 | |
| Barrett M82A1 | 8 | 8 | |
| FN Minimi | 9 | 9 | |
| XM214 Minigun | 10 | 10 | |
| **USSOCOM (Colt)** | 11 | **0** | ⚠️ Index 11 but Num=0 (enum quirk) |
| Combat Knife | 12 | 11 | Secondary weapon, renumbered |
| Chainsaw | 13 | 12 | Secondary weapon, renumbered |
| LAW | 14 | 13 | Secondary weapon, renumbered |
| Flamer | 17 | 14 | Secondary weapon, renumbered |
| Bow (Rambo) | 16 | 15 | Secondary weapon, renumbered |
| Flame Bow | 15 | 16 | Secondary weapon, renumbered |
| M2 (Stationary Gun) | 18 | 30 | Stationary, external num |
| No Weapon | 19 | 255 | Empty slot |
| Frag Grenade | 20 | 50 | Bonus weapon |
| Cluster Grenade | 21 | 51 | Bonus weapon |
| Cluster Bomblet | 22 | 52 | Spawned by cluster grenade |
| Thrown Knife | 23 | 53 | Spawned by knife throw |

### Normal Mode Weapon Stats

Field order per shared/Weapons.pas TGun record: Ammo, AmmoCount, Num, MovementAcc, Bink, Recoil, FireInterval, ..., Speed, HitMultiply, BulletSpread, Push, InheritedVelocity, ModifierLegs/Chest/Head.

| Weapon | Damage (HitMultiply) | Fire Interval (ticks@60Hz) | Ammo | Reload (ticks) | Speed | Bink | MovementAcc | BulletSpread | Push | InheritedVel | Modifiers (L/C/H) | Source |
|--------|-----|------|------|--------|-------|------|-------------|-------------|------|-------------|----------|--------|
| **Desert Eagle** | 1.81 | 24 | 7 | 87 | 19 | 0 | 0.009 | 0.15 | 0.0176 | 0.5 | 0.85/0.95/1.1 | shared/Weapons.pas:498-513 |
| **HK MP5** | 1.01 | 6 | 30 | 105 | 18.9 | 0 | 0 | 0.14 | 0.0112 | 0.5 | 0.85/0.95/1.1 | shared/Weapons.pas:517-532 |
| **AK-74** | 1.004 | 10 | 35 | 165 | 24.6 | -12 | 0.011 | 0.025 | 0.01376 | 0.5 | 0.85/0.95/1.1 | shared/Weapons.pas:536-551 |
| **Steyr AUG** | 0.71 | 7 | 25 | 125 | 26 | 0 | 0 | 0.075 | 0.0084 | 0.5 | 0.85/0.95/1.1 | shared/Weapons.pas:555-570 |
| **SPAS-12** | 1.22 | 32 | 7 | 175 | 14 | 0 | 0 | 0.8 | 0.0188 | 0.5 | 0.85/0.95/1.1 | shared/Weapons.pas:574-589 |
| **Ruger 77** | 2.49 | 45 | 4 | 78 | 33 | 0 | 0.03 | 0 | 0.012 | 0.5 | 1.0/1.05/1.2 | shared/Weapons.pas:593-608 |
| **M79** | 1550 | 6 | 1 | 178 | 10.7 | 0 | 0 | 0 | 0.036 | 0.5 | 0.9/1.0/1.15 | shared/Weapons.pas:612-627 |
| **Barrett M82A1** | 4.45 | 225 | 10 | 70 | 55 | 65 | 0.05 | 0 | 0.018 | 0.5 | 1.0/1.0/1.0 | shared/Weapons.pas:631-646 |
| **FN Minimi** | 0.85 | 9 | 50 | 250 | 27 | 0 | 0.013 | 0.064 | 0.0128 | 0.5 | 0.85/0.95/1.1 | shared/Weapons.pas:650-665 |
| **XM214 Minigun** | 0.468 | 3 | 100 | 480 | 29 | 0 | 0.0625 | 0.3 | 0.0104 | 0.5 | 0.85/0.95/1.1 | shared/Weapons.pas:669-684 |
| **USSOCOM** | 1.49 | 10 | 14 | 60 | 18 | 0 | 0 | 0 | 0.02 | 0.5 | 0.85/0.95/1.1 | shared/Weapons.pas:688-703 |
| **Combat Knife** | 2150 | 6 | 1 | 3 | 6 | 0 | 0 | 0 | 0.12 | 0 | 0.9/1.0/1.15 | shared/Weapons.pas:707-722 |
| **Chainsaw** | 50 | 2 | 200 | 110 | 8 | 0 | 0 | 0 | 0.0028 | 0 | 0.9/1.0/1.15 | shared/Weapons.pas:726-741 |
| **M72 LAW** | 1550 | 6 | 1 | 300 | 23 | 0 | 0 | 0 | 0.028 | 0.5 | 0.9/1.0/1.15 | shared/Weapons.pas:745-760 |
| **Flame Bow** | 8 | 10 | 1 | 39 | 18 | 0 | 0 | 0 | 0 | 0.5 | 0.9/1.0/1.15 | shared/Weapons.pas:764-779 |
| **Rambo Bow** | 12 | 10 | 1 | 25 | 21 | 0 | 0 | 0 | 0.0148 | 0.5 | 0.9/1.0/1.15 | shared/Weapons.pas:783-798 |
| **Flamer** | 19 | 6 | 200 | 5 | 10.5 | 0 | 0 | 0 | 0.016 | 0.5 | 0.9/1.0/1.15 | shared/Weapons.pas:802-817 |
| **M2 MG** | 1.8 | 10 | 100 | 366 | 36 | 0 | 0 | 0 | 0.0088 | 0 | 0.85/0.95/1.1 | shared/Weapons.pas:821-836 |
| **Hands (Punch)** | 330 | 6 | 1 | 3 | 5 | 0 | 0 | 0 | 0 | 0 | 0.9/1.0/1.15 | shared/Weapons.pas:840-855 |
| **Frag Grenade** | 1500 | 80 | 1 | 20 | 5 | 0 | 0 | 0 | 0 | 1 | 1.0/1.0/1.0 | shared/Weapons.pas:859-874 |

### Realistic Mode Weapon Stats

| Weapon | Damage (HitMultiply) | Fire Interval (ticks@60Hz) | Ammo | Reload (ticks) | Speed | Bink | Recoil | MovementAcc | BulletSpread | Push | InheritedVel | Modifiers (L/C/H) | Source |
|--------|-----|------|------|--------|-------|------|--------|-------------|-------------|------|-------------|----------|--------|
| **Desert Eagle** | 1.66 | 27 | 7 | 106 | 19 | 0 | 55 | 0.02 | 0.1 | 0.0164 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:883-898 |
| **HK MP5** | 0.94 | 6 | 30 | 110 | 18.9 | -10 | 9 | 0.01 | 0.03 | 0.0164 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:902-917 |
| **AK-74** | 1.08 | 11 | 35 | 158 | 24 | -10 | 13 | 0.02 | 0 | 0.0132 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:921-936 |
| **Steyr AUG** | 0.68 | 7 | 30 | 126 | 26 | -9 | 11 | 0.01 | 0 | 0.012 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:940-955 |
| **SPAS-12** | 1.2 | 35 | 7 | 175 | 13.2 | 0 | 65 | 0.01 | 0.8 | 0.0224 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:959-974 |
| **Ruger 77** | 2.22 | 52 | 4 | 104 | 33 | 14 | 54 | 0.03 | 0 | 0.0096 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:978-993 |
| **M79** | 1600 | 6 | 1 | 173 | 11.4 | 45 | 420 | 0.03 | 0 | 0.024 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:997-1012 |
| **Barrett M82A1** | 4.95 | 200 | 10 | 170 | 55 | 80 | 0 | 0.07 | 0 | 0.0056 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:1016-1031 |
| **FN Minimi** | 0.81 | 10 | 50 | 261 | 27 | -8 | 8 | 0.02 | 0 | 0.0116 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:1035-1050 |
| **XM214 Minigun** | 0.43 | 4 | 100 | 320 | 29 | -2 | 4 | 0.01 | 0.1 | 0.0108 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:1054-1069 |
| **USSOCOM** | 1.30 | 12 | 12 | 72 | 18 | 0 | 28 | 0.02 | 0 | 0.0172 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:1073-1088 |
| **Combat Knife** | 2250 | 6 | 1 | 3 | 6 | 0 | 10 | 0.01 | 0 | 0.028 | 0 | 0.6/1.0/1.1 | shared/Weapons.pas:1092-1107 |
| **Chainsaw** | 21 | 2 | 200 | 110 | 7.6 | 0 | 1 | 0.01 | 0 | 0.0028 | 0 | 0.6/1.0/1.1 | shared/Weapons.pas:1111-1126 |
| **M72 LAW** | 1500 | 30 | 1 | 495 | 23 | 0 | 9 | 0.01 | 0 | 0.012 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:1130-1145 |
| **Flame Bow** | 8 | 10 | 1 | 39 | 18 | 0 | 10 | 0.01 | 0 | 0 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:1149-1164 |
| **Rambo Bow** | 12 | 10 | 1 | 25 | 21 | 0 | 10 | 0.01 | 0 | 0.0148 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:1168-1183 |
| **Flamer** | 12 | 6 | 200 | 5 | 12.5 | 0 | 10 | 0.01 | 0 | 0.016 | 0.5 | 0.6/1.0/1.1 | shared/Weapons.pas:1187-1202 |
| **M2 MG** | 1.55 | 14 | 100 | 366 | 36 | 0 | 10 | 0.01 | 0 | 0.0088 | 0 | 0.6/1.0/1.1 | shared/Weapons.pas:1206-1221 |
| **Hands (Punch)** | 330 | 6 | 1 | 3 | 5 | 0 | 10 | 0.01 | 0 | 0 | 0 | 0.6/1.0/1.1 | shared/Weapons.pas:1225-1240 |
| **Frag Grenade** | 1500 | 80 | 1 | 20 | 5 | 0 | 10 | 0.01 | 0 | 0 | 1 | 0.6/1.0/1.1 | shared/Weapons.pas:1244-1259 |

## Particle & Damage Modifiers

### Body Part Damage Modifiers

Applied multiplicatively to HitMultiply for bullets hitting specific body parts.

| Location | Normal Mode | Realistic Mode | Source | Notes |
|----------|------------|----------------|--------|-------|
| **Head** | varies by weapon: 1.0–1.2 | 1.1 (most weapons) | TGun.ModifierHead | Bonus damage for headshots |
| **Chest** | varies by weapon: 0.95–1.05 | 1.0 (most weapons) | TGun.ModifierChest | 95–100% of base damage |
| **Legs** | varies by weapon: 0.85–1.0 | 0.6 (most weapons) | TGun.ModifierLegs | Reduced damage, 0.6 in realistic mode |

### Explosion Radii

| Constant | Value (units) | Type | Source | Notes |
|----------|-------|-------|--------|-------|
| **M79 Grenade Explosion Radius** | 64 | Hardcoded | shared/mechanics/Sprites.pas:36 | M79 damage splash range |
| **Frag Grenade Explosion Radius** | 85 | Hardcoded | shared/mechanics/Sprites.pas:37 | Standard grenade damage splash range |
| **Cluster Grenade Explosion Radius** | 35 | Hardcoded | shared/mechanics/Sprites.pas:39 | Individual cluster bomblet damage range |
| **After Explosion Radius** | 50 | Hardcoded | shared/mechanics/Sprites.pas:38 | Secondary explosion collision radius |

### Collision Radii

| Constant | Value (units) | Type | Source | Notes |
|----------|-------|-------|--------|-------|
| **Part Radius** | 7 | Hardcoded | shared/mechanics/Sprites.pas:33 | Player body part collision size |
| **Flag Part Radius** | 10 | Hardcoded | shared/mechanics/Sprites.pas:34 | Flag collision radius |
| **Sprite Radius** | 16 | Hardcoded | shared/mechanics/Sprites.pas:35 | Player overall collision radius |
| **Sprite Col Radius** | 3 | Hardcoded | shared/mechanics/Sprites.pas:42 | Tight collision radius |
| **Base Radius** | 75 | Hardcoded | shared/mechanics/Sprites.pas:40 | Base/spawn point radius |
| **Touchdown Radius** | 28 | Hardcoded | shared/mechanics/Sprites.pas:41 | CTF flag capture zone radius |

## Fire & Status Effects

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **Flamer Bonus Time** | 600 ticks (10 sec @60Hz) | Hardcoded | shared/Constants.pas:184 | Duration of flame god bonus when picked up |
| **Predator Bonus Time** | 1500 ticks (25 sec @60Hz) | Hardcoded | shared/Constants.pas:185 | Duration of predator/invisibility bonus |
| **Berserker Bonus Time** | 900 ticks (15 sec @60Hz) | Hardcoded | shared/Constants.pas:186 | Duration of berserker mode bonus |
| **Vest Bonus (Health)** | 100 | Hardcoded | shared/Constants.pas:182 | Armor points granted by vest pickup |
| **Predator Alpha** | 5 | Hardcoded | shared/Constants.pas:181 | Alpha (transparency) during predator mode (0–255 scale) |
| **On Fire Time** | 60 ticks (1 sec @60Hz) | Hardcoded | shared/Constants.pas:251 | Duration sprite stays "on fire" after flame damage |
| **Less Bleed Time** | 120 ticks (2 sec @60Hz) | Hardcoded | shared/Constants.pas:249 | Duration of reduced bleeding |
| **No Bleed Time** | 300 ticks (5 sec @60Hz) | Hardcoded | shared/Constants.pas:250 | Duration of no bleeding |

## Health & Damage Thresholds

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **Default Health** | 150 | Hardcoded | shared/Constants.pas:75 | Standard spawn health (normal mode) |
| **Realistic Health** | 65 | Hardcoded | shared/Constants.pas:76 | Spawn health in realistic mode |
| **Brutal Death Threshold** | -400 | Hardcoded | shared/Constants.pas:77 | Health below this triggers ragdoll death |
| **Headchop Death Threshold** | -90 | Hardcoded | shared/Constants.pas:78 | Health below this triggers dismemberment death |
| **Helmet Fall Health** | 70 | Hardcoded | shared/Constants.pas:79 | Health at which helmet falls off on impact |
| **Hurt Health** | 25 | Hardcoded | shared/Constants.pas:80 | Damage threshold for "hurt" sound/effect |
| **M2 Hit Multiply** | 2 | Hardcoded | shared/Constants.pas:121 | Stationary gun damage multiplier |
| **M2 Gun Overheat** | 18 | Hardcoded | shared/Constants.pas:123 | M2 overheating threshold (UseTime counter) |
| **Gun Resist Time** | 1200 ticks (20 sec @60Hz) | Hardcoded | shared/Constants.pas:124 | Overheat recovery time for M2 gun |
| **Explosion Impact Multiply** | 3.75 | Hardcoded | shared/Constants.pas:112 | Damage multiplier for explosion hitting alive players |
| **Explosion Dead Impact Multiply** | 4.5 | Hardcoded | shared/Constants.pas:113 | Damage multiplier for explosion hitting dead bodies |

## Jetpack & Flight

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **Jetpack Thrust (On Ground)** | -2.5 × max(JETSPEED, GRAV × 2) | Hardcoded | shared/mechanics/Control.pas:328 | Upward force when jumping with jetpack |
| **Jetpack Thrust (In Air)** | -JETSPEED or -GRAV × 2 | Hardcoded | shared/mechanics/Control.pas:333-334 | Reduced thrust when already airborne |
| **Jetpack Thrust (Prone)** | ±JETSPEED / 2 (horizontal) | Hardcoded | shared/mechanics/Control.pas:336-337 | Horizontal thrust when firing jetpack while prone |
| **Parachute Speed** | -0.5 × 0.06 = -0.03 | Hardcoded | shared/Constants.pas:220 | Slow descent speed with parachute |
| **Parachute Deploy Distance** | 500 units | Hardcoded | shared/Constants.pas:221 | Minimum distance above ground to deploy |

## Flag Mechanics

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **Flag Throw Power** | 4.225 | Hardcoded | shared/mechanics/Sprites.pas:53 | Velocity multiplier when throwing flag |
| **Flag Holding Force Up** | -14 | Hardcoded | shared/mechanics/Sprites.pas:44 | Upward gravity adjustment while holding flag |
| **Flag Stand Force Up** | -16 | Hardcoded | shared/mechanics/Sprites.pas:45 | Upward gravity adjustment for dropped flag |
| **Flag Timeout** | 1500 ticks (25 sec @60Hz) | Hardcoded | shared/Constants.pas:141 | Time before dropped flag returns to base |

## Spawn & Respawn Mechanics

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **Ceasefire Time** | 90 ticks (1.5 sec @60Hz) | Hardcoded | shared/Constants.pas:180 | Invulnerability/no-fire grace period on spawn |
| **Respawn Time (Survival)** | 300 ticks (5 sec @60Hz) | Hardcoded | shared/Constants.pas:253 | Time to respawn in survival mode |
| **Spawn Random Velocity** | 25 | Hardcoded | shared/Constants.pas:139 | Random velocity magnitude on spawn |

## Network & Synchronization

| Constant | Value | Type | Source | Notes |
|----------|-------|------|--------|-------|
| **Fire Interval Network Threshold** | 5 ticks | Hardcoded | shared/Constants.pas:234 | Bullet network send only if FireInterval > this |
| **Force Client Snapshot Interval** | FIREINTERVAL_NET (5 ticks) | Hardcoded | shared/mechanics/Bullets.pas:253 | Burst fire snapshot forcing |

## 60Hz Dependencies

The following constants are explicitly tied to 60 Hz tickrate:

- All timeout values use ticks (multiply by 1/60 for seconds): GRENADE_TIMEOUT (3 sec), FLAMER_TIMEOUT (0.53 sec), MELEE_TIMEOUT (16ms)
- Fire intervals measured in ticks (divide by 60 for seconds): Minigun fires every 3 ticks = 20 shots/sec
- Reload times in ticks: Desert Eagle 87 ticks = 1.45 sec
- Speed constants are per-frame deltas applied at 60 Hz

## CVAR_SYNC (Server-Pushed) Constants

| CVar | Value | Sync Flag | Source | Notes |
|------|-------|----------|--------|-------|
| **sv_gravity** | 0.06 | CVAR_SYNC | shared/Cvar.pas:985 | Pushed from server, overrides hardcoded gravity in all sub-systems (SpriteParts, BulletParts, SparkParts, GostekSkeleton) |

All other constants listed above are hardcoded (not CVAR_SYNC) and cannot be changed per-game without recompilation.