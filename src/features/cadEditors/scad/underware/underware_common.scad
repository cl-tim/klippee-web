// Shared utilities for Underware 2.0 models.
// This file intentionally has no top-level geometry.

function underware_is_integer(value) = value == floor(value);

// Override from the command line with -D Geometry_Quality=\"Draft|Normal|Fine\".
Geometry_Quality = "Normal"; // [Draft, Normal, Fine]
function underware_fn(normal) =
    Geometry_Quality == "Draft" ? max(12, ceil(normal / 2)) :
    Geometry_Quality == "Fine" ? normal * 2 :
    normal;

// Draft previews use a root-diameter cylinder instead of calculating the
// helical thread. Normal and Fine always retain the printable thread profile.
module underware_internal_thread_cutout(
    diameter,
    length,
    pitch,
    flank_angle,
    thread_depth,
    thread_slop,
    teardrop = false,
    anchor = TOP
) {
    if (Geometry_Quality == "Draft")
        cyl(
            d=max(0.1, diameter-2*thread_depth+2*thread_slop),
            h=length+0.02,
            $fn=underware_fn(32),
            anchor=anchor
        );
    else
        trapezoidal_threaded_rod(
            d=diameter,
            l=length,
            pitch=pitch,
            flank_angle=flank_angle,
            thread_depth=thread_depth,
            $fn=underware_fn(50),
            internal=true,
            bevel2=true,
            blunt_start=false,
            teardrop=teardrop,
            anchor=anchor,
            $slop=thread_slop
        );
}

module underware_validate_channel(
    grid_size,
    width_units,
    internal_heights,
    length_units = undef
) {
    assert(grid_size > 0, "Grid_Size must be greater than zero.");
    assert(width_units > 0, "Channel width must be greater than zero.");
    assert(underware_is_integer(width_units), "Channel width in units must be an integer.");
    assert(min(internal_heights) >= 12, "Channel internal height must be at least 12 mm.");
    assert(is_undef(length_units) || length_units > 0, "Channel length must be greater than zero.");
    children();
}

module underware_validate_transition(length_mm, rise_distance, rise_offset = 0) {
    first_station = length_mm / 2 - rise_distance / 2 + rise_offset;
    last_station = length_mm / 2 + rise_distance / 2 + rise_offset;

    assert(rise_distance > 0, "Rise_Distance must be greater than zero.");
    assert(first_station >= 0, "Rise_Distance/Rise_Offset places the transition before the channel start.");
    assert(last_station <= length_mm, "Rise_Distance/Rise_Offset places the transition after the channel end.");
    children();
}

module underware_mount_cutout(
    method,
    inner_diameter,
    outer_diameter,
    inner_depth,
    magnet_diameter,
    magnet_thickness,
    magnet_tolerance,
    wood_thread_diameter,
    wood_head_diameter,
    wood_head_height,
    thread_diameter,
    thread_length,
    thread_pitch,
    thread_flank_angle,
    thread_depth,
    thread_slop,
    multipoint_outer_diameter = undef,
    cone = false,
    base_thickness = 3.5
) {
    if (method == "Direct Multiboard Screw") {
        up(inner_depth)
            cyl(h=8, d=inner_diameter, $fn=underware_fn(25), anchor=TOP)
                attach(TOP, BOT, overlap=0.01)
                    cyl(
                        h=base_thickness-inner_depth+0.02,
                        d1=cone ? inner_diameter : outer_diameter,
                        d2=outer_diameter,
                        $fn=underware_fn(25)
                    );
    } else if (method == "Direct Multipoint Screw") {
        assert(!is_undef(multipoint_outer_diameter), "Multipoint screw diameter is not configured for this model.");
        up(inner_depth)
            cyl(h=8, d=inner_diameter, $fn=underware_fn(25), anchor=TOP)
                attach(TOP, BOT, overlap=0.01)
                    cyl(
                        h=base_thickness-inner_depth+0.02,
                        d1=cone ? inner_diameter : multipoint_outer_diameter,
                        d2=multipoint_outer_diameter,
                        $fn=underware_fn(25)
                    );
    } else if (method == "Magnet") {
        assert(magnet_thickness + magnet_tolerance <= base_thickness,
            "Magnet recess is deeper than the channel base.");
        up(magnet_thickness+magnet_tolerance-0.01)
            cyl(
                h=magnet_thickness+magnet_tolerance,
                d=magnet_diameter+magnet_tolerance,
                $fn=underware_fn(50),
                anchor=TOP
            );
    } else if (method == "Wood Screw") {
        assert(wood_head_height < base_thickness, "Wood screw head is too tall for the channel base.");
        up(base_thickness-wood_head_height)
            cyl(
                h=base_thickness-wood_head_height+0.05,
                d=wood_thread_diameter,
                $fn=underware_fn(25),
                anchor=TOP
            )
                attach(TOP, BOT, overlap=0.01)
                    cyl(
                        h=wood_head_height+0.05,
                        d1=wood_thread_diameter,
                        d2=wood_head_diameter,
                        $fn=underware_fn(25)
                    );
    } else if (method == "Flat") {
        // Intentionally leave the base solid.
    } else {
        assert(method == "Threaded Snap Connector", str("Unknown mounting method: ", method));
        up(thread_length-0.01)
            underware_internal_thread_cutout(
                diameter=thread_diameter,
                length=thread_length,
                pitch=thread_pitch,
                flank_angle=thread_flank_angle,
                thread_depth=thread_depth,
                thread_slop=thread_slop,
                anchor=TOP
            );
    }
}
