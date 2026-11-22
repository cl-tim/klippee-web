// Shared mounting backers for Underware accessories.
// Callers provide the thread profile and backer behavior through their
// existing global Customizer parameters.

include <underware_common.scad>

module underware_threaded_snap_backer(
    backWidth,
    backHeight,
    distanceBetweenSlots,
    thread_length = 3.6,
    anchor = BOT,
    orient = UP,
    spin = 0
) {
    assert(backWidth > Outer_Diameter_Sm*2,
        "Threaded backer is too narrow for the configured snap thread.");
    assert(backHeight > Outer_Diameter_Sm*2,
        "Threaded backer is too short for the configured snap thread.");
    assert(distanceBetweenSlots > 0, "Threaded snap spacing must be positive.");

    diff()
    tag(Backer_Negatives_Only ? "remove" : "")
    cuboid(
        size=[backWidth, Force_Back_Thickness == 0 ? 3.59 : Force_Back_Thickness, backHeight],
        rounding=edgeRounding,
        except_edges=BACK,
        anchor=anchor,
        orient=orient,
        spin=spin
    ) {
        tag(Backer_Negatives_Only ? "keep" : "remove")
        attach(FRONT, BOT, inside=true, shiftout=0.01)
            grid_copies(
                size=[backWidth-Outer_Diameter_Sm*2, backHeight-Outer_Diameter_Sm*2],
                spacing=distanceBetweenSlots
            )
                underware_internal_thread_cutout(
                    diameter=Outer_Diameter_Sm,
                    length=thread_length,
                    pitch=Pitch_Sm,
                    flank_angle=Flank_Angle_Sm,
                    thread_depth=Thread_Depth_Sm,
                    thread_slop=Slop,
                    teardrop=true,
                    anchor=TOP
                );
        children();
    }
}
