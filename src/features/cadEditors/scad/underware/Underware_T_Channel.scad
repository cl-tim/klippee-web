/*Created by BlackjackDuck (Andy) and Hands on Katie. Original model from Hands on Katie (https://handsonkatie.com/)
This code and all parts derived from it are Licensed Creative Commons 4.0 Attribution Non-Commercial Share-Alike (CC-BY-NC-SA)

Documentation available at https://handsonkatie.com/underware-2-0-the-made-to-measure-collection/

Change Log:
- 2024-12-06 
    - Initial release
- 2024-12-09
    - Fix to threading of snap connector by adding flare and new slop parameter
- 2025-02-27
    - New mitered corners option. Thanks @porteregr on GitHub!
- 2025-04-09
    - Additional Holding Strength now available! For larger channels, I recommend 0.6.
- 2025-05-28
    - Fix for floating parts when holding strength is used on wider channels

Credit to 
    First and foremost - Katie and her community at Hands on Katie on Youtube, Patreon, and Discord
    @David D on Printables for Multiconnect
    Jonathan at Keep Making for Multiboard
    @cosmicdust on MakerWorld and @freakadings_1408562 on Printables for the idea of diagonals (forward and turn)
    @siyrahfall+1155967 on Printables for the idea of top exit holes
    @Lyric on Printables for the flush connector idea
    @fawix on GitHub for her contributions on parameter descriptors

*/

include <BOSL2/std.scad>
include <BOSL2/rounding.scad>
include <BOSL2/threading.scad>
include <underware_common.scad>

/*[Choose Part]*/
Base_Top_or_Both = "Both"; // [Base, Top, Both]

/*[Channel Height and Width]*/
//Width of channel in units (default unit is 25mm)
Channel_Width_in_Units = 1;
//Height (Z axis) inside the channel (in mm)
Channel_Internal_Height = 12; //[12:6:72]
//Provide extra space for cables to turn through the T
Corner_Style = "Sharp"; // [Sharp, Mitered]

/*[Mounting Options]*/
//How do you intend to mount the channels to a surface such as Honeycomb Storage Wall or Multiboard? See options at https://handsonkatie.com/underware-2-0-the-made-to-measure-collection/
Mounting_Method = "Threaded Snap Connector"; //[Threaded Snap Connector, Direct Multiboard Screw, Magnet, Wood Screw, Flat]
//Diameter of the magnet (in mm)
Magnet_Diameter = 4.0; 
//Thickness of the magnet (in mm)
Magnet_Thickness = 1.5;
//Add a tolerance to the magnet hole to make it easier to insert the magnet.
Magnet_Tolerance = 0.1;
//Wood screw diameter (in mm)
Wood_Screw_Thread_Diameter = 3.5;
//Wood Screw Head Diameter (in mm)
Wood_Screw_Head_Diameter = 7;
//Wood Screw Head Height (in mm)
Wood_Screw_Head_Height = 1.75;

/*[Advanced Options]*/
//Units of measurement (in mm) for hole and length spacing. Multiboard is 25mm. Untested
Grid_Size = 25;
//Color of part (color names found at https://en.wikipedia.org/wiki/Web_colors)
Global_Color = "SlateBlue";
//Slop in thread. Increase to make threading easier. Decrease to make threading harder.
Slop = 0.075;

/*[Beta Features - Please Send Feedback]*/
//BETA FEATURE: For channels wider than 1 unit or taller than 18mm, reduce the top channel width to increase holding strength.
Flex_Compensation_Scaling = 0.99; // 
//BETA FEATURE - Works with Original Profile Only: Change snap profile for strong holding strength. Not backwards compatible.
Additional_Holding_Strength = 0.0;//[0:0.1:1.5]

/*[Hidden]*/
//BETA FEATURE: Change the profile type to an inverse connection where the top clips from the inside allowing stronger connections. Not backwards compatible. This profile is still likely to change.
Profile_Type = "Original"; // [Original, v2.5]

channelWidth = Channel_Width_in_Units * Grid_Size;
baseHeight = 9.63;
topHeight = 10.968;
interlockOverlap = 3.09; //distance that the top and base overlap each other
interlockFromFloor = 6.533; //distance from the bottom of the base to the bottom of the top when interlocked
partSeparation = 10;

///*[Visual Options]*/
Debug_Show_Grid = false;
//View the parts as they attach. Note that you must disable this before exporting for printing. 
Show_Attached = false;

///*[Small Screw Profile]*/
//Distance (in mm) between threads
Pitch_Sm = 3;
//Diameter (in mm) at the outer threads
Outer_Diameter_Sm = 6.747;
//Angle of the one side of the thread
Flank_Angle_Sm = 60;
//Depth (in mm) of the thread
Thread_Depth_Sm = 0.5;
//Diameter of the hole down the middle of the screw (for strength)
Inner_Hole_Diameter_Sm = 3.3;


///*[Direct Screw Mount]*/
Base_Screw_Hole_Inner_Diameter = 7;
Base_Screw_Hole_Outer_Diameter = 15;
//Thickness of of the base bottom and the bottom of the recessed hole (i.e., thicknes of base at the recess)
Base_Screw_Hole_Inner_Depth = 1;
Base_Screw_Hole_Cone = false;

underware_validate_channel(Grid_Size, Channel_Width_in_Units, [Channel_Internal_Height]);

/*

***BEGIN DISPLAYS***

*/

if(Base_Top_or_Both != "Top")
color_this(Global_Color)
    left(Show_Attached ? 0 : partSeparation)
        tIntersectionBase(widthMM = channelWidth, anchor=Show_Attached ? BOT : BOT+RIGHT);
if(Base_Top_or_Both != "Base")
color_this(Global_Color)
    right(Show_Attached ? 0 : partSeparation)
    up(Show_Attached ? interlockFromFloor : 0) 
        tIntersectionTop(widthMM = channelWidth, heightMM = Channel_Internal_Height, anchor=Show_Attached ? BOT : TOP+RIGHT, orient= Show_Attached ? TOP : BOT);

/*

***BEGIN MODULES***

*/

//T CHANNELS
module tIntersectionBase(widthMM, anchor, spin, orient){
    attachable(anchor, spin, orient, size=[channelWidth+Grid_Size, channelWidth+Grid_Size*2, baseHeight]){
        down(baseHeight/2) 
        left(Grid_Size/2)
        union(){
            diff("channelClear holes") {
                if(Corner_Style == "Mitered") {
                    miterTIntersectionBase();
                }
                //side channel
                path_sweep(baseProfile(widthMM = widthMM), turtle(["move", channelWidth/2 + Grid_Size])){
                    tag("channelClear") zrot(90) fwd(channelWidth/2) straightChannelBaseDeleteTool(widthMM = channelWidth+0.02, lengthMM = channelWidth/2 + Grid_Size, anchor=BOT);
                //long channel
                zrot(90) left(channelWidth/2+Grid_Size)path_sweep(baseProfile(widthMM = widthMM), turtle(["move", channelWidth+Grid_Size*2]));

                tag("channelClear") straightChannelBaseDeleteTool(widthMM = channelWidth+0.02, lengthMM = channelWidth+Grid_Size*2, anchor=BOT);
                tag("holes") grid_copies(n=2+Channel_Width_in_Units, spacing=Grid_Size) 
                    if(Mounting_Method == "Direct Multiboard Screw") up(Base_Screw_Hole_Inner_Depth) cyl(h=8, d=Base_Screw_Hole_Inner_Diameter, $fn=25, anchor=TOP) attach(TOP, BOT, overlap=0.01) cyl(h=3, d=Base_Screw_Hole_Outer_Diameter, $fn=25);
                    else if(Mounting_Method == "Magnet") up(Magnet_Thickness+Magnet_Tolerance-0.01) cyl(h=Magnet_Thickness+Magnet_Tolerance, d=Magnet_Diameter+Magnet_Tolerance, $fn=50, anchor=TOP);
                    else if(Mounting_Method == "Wood Screw") up(3.5 - Wood_Screw_Head_Height) cyl(h=3.5 - Wood_Screw_Head_Height+0.05, d=Wood_Screw_Thread_Diameter, $fn=25, anchor=TOP)
                        //wood screw head
                        attach(TOP, BOT, overlap=0.01) cyl(h=Wood_Screw_Head_Height+0.05, d1=Wood_Screw_Thread_Diameter, d2=Wood_Screw_Head_Diameter, $fn=25);
                    else if(Mounting_Method == "Flat") ; //do nothing
                    //Default is Threaded Snap Connector
                    else up(5.99) trapezoidal_threaded_rod(d=Outer_Diameter_Sm, l=6, pitch=Pitch_Sm, flank_angle = Flank_Angle_Sm, thread_depth = Thread_Depth_Sm, $fn=50, internal=true, bevel2 = true, blunt_start=false, anchor=TOP, $slop=Slop);
                }
            }
        }
        children();
    }
}

module tIntersectionTop(widthMM, heightMM, anchor, spin, orient){
    attachable(anchor, spin, orient, size=[channelWidth+Grid_Size, channelWidth+Grid_Size*2, topHeight + (heightMM-12)]){
        down((topHeight + (heightMM-12))/2) left(Grid_Size/2)
        diff("channelClear"){
            if(Corner_Style == "Mitered") {
                miterTIntersectionTop(heightMM);
            }
            //side channel
            path_sweep(topProfile(widthMM = widthMM, heightMM = heightMM), turtle(["move", channelWidth/2 + Grid_Size])){
                tag("channelClear") zrot(90) fwd(channelWidth/2) straightChannelTopDeleteTool(widthMM = channelWidth+0.02, lengthMM = channelWidth/2 + Grid_Size, heightMM = heightMM, anchor=BOT);
                //long channel
                zrot(90) left(channelWidth/2+Grid_Size)path_sweep(topProfile(widthMM = widthMM, heightMM = heightMM), turtle(["move", channelWidth+Grid_Size*2]));
                tag("channelClear") straightChannelTopDeleteTool(widthMM = channelWidth+0.02, lengthMM = channelWidth+Grid_Size*2, heightMM = heightMM, anchor=BOT);
            }
        }
        children();
    }
}

module miterTIntersectionBase() {
    // Move to the right edge of the base.
    right((channelWidth+Grid_Size)/2){
        // For each side move left so that the miter starts at about Grid_Size/2 from the end of the side channel.
        // The move lengths are trig constants for right isoceles triangles adjusted for the width of our tools.
        left(Grid_Size)fwd(channelWidth/2 + Grid_Size/2) zrot(45) path_sweep(baseProfile(widthMM = Grid_Size), turtle(["move", Grid_Size*1.3]));
        tag("channelClear")left(Grid_Size/2)fwd(channelWidth/2) zrot(-45) straightChannelBaseDeleteTool(widthMM = Grid_Size+0.02, lengthMM = Grid_Size*1.4, anchor=BOT);
        left(Grid_Size)back(channelWidth/2 + Grid_Size/2) zrot(-45) path_sweep(baseProfile(widthMM = Grid_Size), turtle(["move", Grid_Size*1.3]));
        tag("channelClear")left(Grid_Size/2)back(channelWidth/2) zrot(45) straightChannelBaseDeleteTool(widthMM = Grid_Size+0.02, lengthMM = Grid_Size*1.4, anchor=BOT);
    }
}

module miterTIntersectionTop(heightMM) {
    // Move to the right edge of the top.
    right((channelWidth+Grid_Size)/2){
        // For each side move left so that the miter starts at about Grid_Size/2 from the end of the side channel.
        // The move lengths are trig constants for right isoceles triangles adjusted for the width of our tools.
        left(Grid_Size){
            fwd(channelWidth/2 + Grid_Size/2) zrot(45) path_sweep(topProfile(widthMM = Grid_Size, heightMM = heightMM), turtle(["move", Grid_Size*1.25]));
            back(channelWidth/2 + Grid_Size/2) zrot(-45) path_sweep(topProfile(widthMM = Grid_Size, heightMM = heightMM), turtle(["move", Grid_Size*1.25]));
        }
        tag("channelClear")left(Grid_Size/2){
            fwd(channelWidth/2) zrot(-45) straightChannelTopDeleteTool(widthMM = Grid_Size+0.02, lengthMM = Grid_Size*1.4, heightMM = heightMM, anchor=BOT);
            back(channelWidth/2) zrot(45) straightChannelTopDeleteTool(widthMM = Grid_Size+0.02, lengthMM = Grid_Size*1.4, heightMM = heightMM, anchor=BOT);
        }
    }
}

//shared modules - consider copying these to the other files until MultiWorld supports shared libraries
module straightChannelBaseDeleteTool(lengthMM, widthMM, anchor, spin, orient){
    attachable(anchor, spin, orient, size=[widthMM, lengthMM, baseHeight]){
        fwd(lengthMM/2) down(maxY(baseProfileHalf())/2)
        zrot(90) path_sweep(baseDeleteProfile(widthMM = widthMM), turtle(["xmove", lengthMM])); 
    children();
    }
}

module straightChannelTopDeleteTool(lengthMM, widthMM, heightMM = 12, anchor, spin, orient){
    attachable(anchor, spin, orient, size=[widthMM, lengthMM, topHeight + (heightMM-12)]){
        fwd(lengthMM/2) down(topHeight/2 + (heightMM - 12)/2)
        zrot(90) path_sweep(topDeleteProfile(widthMM = widthMM, heightMM = heightMM), turtle(["xmove", lengthMM])); 
    children(); 
    }
}


include <underware_profiles.scad>
