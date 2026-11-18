#!/usr/bin/env python3
"""build_emma_anims.py  SRC_ARIEL_ANIMS.glb  EMMA_SKINNED.glb  OUT_DIR
Retargets all of Ariel's clips to Emma's skeleton, derives the Emma-only clips and writes
   OUT_DIR/Emma_Merged_Animations.glb   (skeleton + every clip; same clip names as Ariel's merged file + Emma_* extras)
   OUT_DIR/emma_clips.json              (preset -> clip map, loop mode, durations: read by the Ariel Rig Viewer)"""
import sys, os, json
sys.path.insert(0, os.path.dirname(__file__))
from retarget import *
from derive import *
from postfx import *

# preset button -> (clip, loop)   loop: 'repeat' | 'once' | 'pingpong'
PRESETS = [
 ('idle',        'Emma_Idle',          'repeat', 'Idle (breathing + blink)'),
 ('walk',        'Walking',            'repeat', 'Walk'),
 ('run',         'Running',            'repeat', 'Run'),
 ('jump',        'Regular_Jump',       'once',   'Jump (full arc)'),
 ('jump_start',  'Emma_Jump_Start',    'once',   'Jump: start'),
 ('jump_loop',   'Emma_Jump_Loop',     'repeat', 'Jump: air loop'),
 ('fall',        'Emma_Fall',          'repeat', 'Fall'),
 ('land',        'Emma_Land',          'once',   'Land'),
 ('climb',       'climbing_up_wall',   'once',   'Climb up'),
 ('climb_hang',  'Emma_Climb_Hang',    'repeat', 'Climb: hang'),
 ('climb_side',  'Quad_Climb_Right',   'once',   'Climb: traverse right'),
 ('ladder',      'Ladder_Climb_Finish','once',   'Ladder'),
 ('swim',        'Swim_Forward',       'repeat', 'Swim'),
 ('swim_idle',   'Emma_Swim_InPlace',  'repeat', 'Swim (in place)'),
 ('swing',       'Swing_on_Rope_to_Ground','once','Swing on rope'),
 ('swing_loop',  'Emma_Swing_Loop',    'repeat', 'Swing on rope (loop)'),
 ('climb_loop',  'Emma_Climb_Loop',    'repeat', 'Climb up (loop)'),
 ('climb_side_loop','Emma_Climb_Side_Loop','repeat','Climb traverse (loop)'),
 ('ladder_loop', 'Emma_Ladder_Loop',   'repeat', 'Ladder (loop)'),
 ('swing_bar_loop','Emma_GrabBar_Loop','repeat', 'Grab bar and swing (loop)'),
 ('swing_bar',   'Grab_Bar_and_Swing_Forward','once','Grab bar and swing'),
 ('crouch',      'Crouch_Walk_Right_with_Torch_inplace','repeat','Crouch walk'),
 ('prone',       'Crawl_Backward_inplace','repeat','Crawl'),
 ('turn_left',   'Emma_Turn_L',        'once',   'Turn left (pivot)'),
 ('turn_right',  'Emma_Turn_R',        'once',   'Turn right (pivot)'),
 ('talk',        'Acting_Talk',        'repeat', 'Talk'),
 ('wave',        'Acting_Wave_Happy',  'once',   'Wave'),
 ('think',       'Acting_Thinking',    'repeat', 'Think'),
 ('surprised',   'Acting_Surprised',   'once',   'Surprised'),
 ('mount',       'Mount_Step',         'once',   'Board: step on'),
 ('dismount',    'Dismount_Step',      'once',   'Board: step off'),
]

def main(src, dst, outdir, ref_char=None, with_derived=True):
    os.makedirs(outdir, exist_ok=True)
    out, SB, k = retarget(src, dst, ref_char=ref_char)
    Fb = frame_from_skel(SB); up = Fb[:,1]
    if with_derived:
        J = out['Regular_Jump']; C = out['climbing_up_wall']
        base = slice_clip(out['Idle_Breathe_Blink'], 0.6, 3.0)      # Ariel's idle clip starts in a mid-stride lead-in: use the settled part
        d = {
         'Emma_Idle': pingpong(out['Idle_Breathe_Blink'], 0.5, 3.0),
         'Emma_Jump_Start': slice_clip(J, 0.0, 0.62), 'Emma_Jump_Loop': pingpong(J, 0.64, 0.98), 'Emma_Fall': pingpong(J, 0.80, 0.98),
         'Emma_Land': slice_clip(J, 1.02, 1.80), 'Emma_Climb_Hang': pingpong(C, 0.53, 0.93),
         'Emma_Swim_InPlace': in_place(out['Swim_Forward'], up),
         'Emma_Turn_L': pivot_turn(base, SB, up, +90), 'Emma_Turn_R': pivot_turn(base, SB, up, -90),
        }
        out.update(d)
        # seamless loop variants (net root travel removed, last 0.5 s crossfaded into the first pose); the originals stay untouched for the game's state machine
        for nm, src_c, bl in [('Emma_Swing_Loop','Swing_on_Rope_to_Ground',0.6),('Emma_Climb_Loop','climbing_up_wall',0.5),('Emma_Climb_Side_Loop','Quad_Climb_Right',0.4),
                              ('Emma_Ladder_Loop','Ladder_Climb_Finish',0.5),('Emma_GrabBar_Loop','Grab_Bar_and_Swing_Forward',0.5)]:
            out[nm] = loopify(out[src_c], SB, up, bl)
        for c_, bl in [('Acting_Talk',0.5),('Acting_Thinking',0.5),('Emma_Swim_InPlace',0.5)]:
            out[c_] = loopify(out[c_], SB, up, bl)       # these 'repeat' presets had 40-50 deg pops at the loop point
    apply_relaxed_hand(out, SB)                           # natural curled fingers where the hand hangs; grabbing clips excluded by name
    p = os.path.join(outdir, 'Emma_Merged_Animations.glb')
    st = write_animation_glb(out, SB, dst, p)
    man = {'rig': 'Emma (Ariel bone names)', 'rootMotionScale': k, 'source': 'Ariel/Autumn merged animations retargeted by tools/retarget.py',
           'clips': {c: {'duration': round(float(v['dur']),4)} for c, v in out.items()},
           'presets': [{'id': i, 'clip': c, 'loop': l, 'label': lab} for i, c, l, lab in PRESETS if c in out]}
    json.dump(man, open(os.path.join(outdir, 'emma_clips.json'), 'w'), indent=1)
    print('wrote', p, os.path.getsize(p)/1e6, 'MB', st, len(out), 'clips')
    return out, SB

if __name__ == '__main__': main(*sys.argv[1:5])
