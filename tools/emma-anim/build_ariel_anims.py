#!/usr/bin/env python3
"""build_ariel_anims.py  OLD_ARIEL_ANIMS.glb  NEW_ARIEL_CHARACTER.glb  OLD_ARIEL_CHARACTER.glb  OUT.glb
Ariel_JOTS rebuild: the new Ariel character has the same 172-bone skeleton/bone names but a relaxed rest pose (arms down) instead of the sculpt's reach pose.
All of the old merged clips are re-retargeted onto it with the Emma pipeline (retarget + fix_arms + fix_jump + relaxed_hand / grip_hand finger presets, explicit tracks on every bone).
Clip names are unchanged (the game's state machine and the Rig Viewer use them)."""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from retarget import *
from postfx import *
from derive import *

def main(src, dst, ref_char, out_path):
    out, SB, k = retarget(src, dst, ref_char=ref_char)
    fix_arms(out, SB); fix_jump(out, SB)
    pre = load_preset('relaxed_hand'); grip = load_preset('grip_hand')
    idle = out['Idle_Breathe_Blink']
    for n, q in relaxed_hand_quats(SB, pre).items(): idle['rot'][n] = np.tile(q, (len(idle['t']), 1))
    REF = idle_hand_reference(idle, SB, pre); GRIP = relaxed_hand_quats(SB, grip)
    rep = {}; apply_hand_pose(out, SB, REF, GRIP, report=rep)
    st = write_animation_glb(out, SB, dst, out_path)
    print('wrote', out_path, os.path.getsize(out_path)/1e6, 'MB', st, len(out), 'clips', 'rootMotionScale', k)
    return out, SB

if __name__ == '__main__': main(*sys.argv[1:5])
