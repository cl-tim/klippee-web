/*Created by Hands on Katie and BlackjackDuck (Andy)
This code and all parts derived from it are Licensed Creative Commons 4.0 Attribution Non-Commercial Share-Alike (CC-BY-NC-SA)

Documentation available at https://handsonkatie.com/underware-2-0-the-made-to-measure-collection/

Change Log:
- 2024-12-06 
    - Initial release
- 2024-12-09
    - Fix to threading of snap connector by adding flare and new slop parameter
2025-03-20
    - Stronger profile options

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

/*[Channel Size]*/
//Width (X axis) of channel in units. Default unit is 25mm
Channel_Width_in_Units = 1;  // Ensure this is an integer
//Height (Z axis) inside the channel (in mm)
Channel_Internal_Height = 12; //[12:6:72]
//Length (Y axis) of channel in units. Default unit is 25mm
Channel_Length_Units = 5; 

/*[Mounting Options]*/
//How do you intend to mount the channels to a surface such as Honeycomb Storage Wall or Multiboard? See options at https://handsonkatie.com/underware-2-0-the-made-to-measure-collection/
Mounting_Method = "Threaded Snap Connector"; //[Threaded Snap Connector, Direct Multiboard Screw, Direct Multipoint Screw, Magnet, Wood Screw, Flat]
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

/*[Cord Cutouts]*/
Number_of_Cord_Cutouts = 0;
//Cutouts on left side, right side, or both (note that it can be flipped so left and right is moot)
Cord_Side_Cutouts = "Both Sides"; //[Left Side, Right Side, Both Sides, None]
//Width of each cord cutout (in mm)
Cord_Cutout_Width = 12;
// in mm
Distance_Between_Cutouts = 25;
//Distance (in mm) to offset cutouts along Y axis. Forward is positive, back is negative
Shift_Cutouts_Forward_or_Back = 0;

/*[Text Label]*/
//Labels (1) only work on MakerWorld, (2) must be exported as 3MF, and (3) must be imported into slicer as project (not geometry).
Add_Label = false;
//Text to appear on label
Text = "Hands on Katie";  // Text to be displayed
// Adjust the X axis position of the text
Text_x_coordinate = 0; 
//Depth of text (in mm). Increments of 0.2 to match layer heights. 
Text_Depth = 0.0; // [0:0.2:1] 
//Font must be installed on local machine if using local OpenSCAD
Font = "Raleway"; // [Asap, Bangers, Changa One, Chewy, Harmony OS Sans,Inter,Inter Tight,Lora,Merriweather Sans,Montserrat,Noto Emoji,Noto Sans,Noto Sans Adlam,Noto Sans Adlam Unjoined,Noto Sans Arabic,Noto Sans Arabic UI,Noto Sans Armenian,Noto Sans Balinese,Noto Sans Bamum,Noto Sans Bassa Vah,Noto Sans Bengali,Noto Sans Bengali UI,Noto Sans Canadian Aboriginal,Noto Sans Cham,Noto Sans Cherokee,Noto Sans Devanagari,Noto Sans Display,Noto Sans Ethiopic,Noto Sans Georgian,Noto Sans Gujarati,Noto Sans Gunjala Gondi,Noto Sans Gurmukhi,Noto Sans Gurmukhi UI,Noto Sans HK,Noto Sans Hanifi Rohingya,Noto Sans Hebrew,Noto Sans JP,Noto Sans Javanese,Noto Sans KR,Noto Sans Kannada,Noto Sans Kannada UI,Noto Sans Kawi,Noto Sans Kayah Li,Noto Sans Khmer,Noto Sans Khmer UI,Noto Sans Lao,Noto Sans Lao Looped,Noto Sans Lao UI,Noto Sans Lisu,Noto Sans Malayalam,Noto Sans Malayalam UI,Noto Sans Medefaidrin,Noto Sans Meetei Mayek,Noto Sans Mono,Noto Sans Myanmar,Noto Sans NKo Unjoined,Noto Sans Nag Mundari,Noto Sans New Tai Lue,Noto Sans Ol Chiki,Noto Sans Oriya,Noto Sans SC,Noto Sans Sinhala,Noto Sans Sinhala UI,Noto Sans Sora Sompeng,Noto Sans Sundanese,Noto Sans Symbols,Noto Sans Syriac,Noto Sans Syriac Eastern,Noto Sans TC,Noto Sans Tai Tham,Noto Sans Tamil,Noto Sans Tamil UI,Noto Sans Tangsa,Noto Sans Telugu,Noto Sans Telugu UI,Noto Sans Thaana,Noto Sans Thai,Noto Sans Thai UI,Noto Sans Vithkuqi,Nunito,Nunito Sans,Open Sans,Open Sans Condensed,Oswald,Playfair Display,Plus Jakarta Sans,Raleway,Roboto,Roboto Condensed,Roboto Flex,Roboto Mono,Roboto Serif,Roboto Slab,Rubik,Source Sans 3,Ubuntu Sans,Ubuntu Sans Mono,Work Sans]
//Styling of selecte font. Note that not all fonts support all styles. 
Font_Style = "Regular"; // [Regular,Bold,Medium,SemiBold,Light,ExtraBold,Black,ExtraLight,Thin,Bold Italic,Italic,Light Italic,Medium Italic]
Text_size = 10;    // Font size
//Color of label text (color names found at https://en.wikipedia.org/wiki/Web_colors)
Text_Color = "Pink";
surname_font = str(Font , ":style=", Font_Style);

/*[Advanced Options]*/
//Units of measurement (in mm) for hole and length spacing. Multiboard is 25mm. Untested
Grid_Size = 25;
//Color of part (color names found at https://en.wikipedia.org/wiki/Web_colors)
Global_Color = "SlateBlue";
//0 to use Channel_Width_in_Units, otherwise use this value as internal width in MM
Override_Width_Using_Internal_MM = 0; 
//Slop in thread. Increase to make threading easier. Decrease to make threading harder.
Slop = 0.075;

/*[Beta Features - Please Send Feedback]*/

//BETA FEATURE: For channels wider than 1 unit or taller than 18mm, reduce the top channel width to increase holding strength.
Flex_Compensation_Scaling = 0.99; // 
//BETA FEATURE - Works with Original Profile Only: Change snap profile for strong holding strength. Not backwards compatible.
Additional_Holding_Strength = 0.0;//[0:0.1:1.5]
//BETA FEATURE: Change the profile type to an inverse connection where the top clips from the inside allowing stronger connections. Not backwards compatible. This profile is still likely to change.
Profile_Type = "Original"; //[Original, v2.5]

/*[Hidden]*/


channelWidth = Override_Width_Using_Internal_MM == 0 ? Channel_Width_in_Units * Grid_Size : Override_Width_Using_Internal_MM + 6;
baseHeight = 9.63;
topHeight = 10.968;
interlockOverlap = 3.09; //distance that the top and base overlap each other
interlockFromFloor = 6.533; //distance from the bottom of the base to the bottom of the top when interlocked
partSeparation = 10;

selectTopProfile = Profile_Type == "Original" ? topProfileHalf(Channel_Internal_Height) : topProfileInverseHalf(Channel_Internal_Height);
selectBaseProfile = Profile_Type == "Original" ? baseProfileHalf() : baseProfileInverseHalf();
//scale the top inward in some circumstances for a stronger connection
topScaling = Profile_Type == "Original" && (Channel_Width_in_Units > 1 || Channel_Internal_Height > 18) ?  Flex_Compensation_Scaling : 1;
if (Debug_Echo) echo(str("Top Channel Scaling: ", topScaling));

///*[Visual Options]*/
Debug_Show_Grid = false;
Debug_Echo = false;
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
MultipointBase_Screw_Hole_Outer_Diameter = 16;

underware_validate_channel(Grid_Size, Channel_Width_in_Units, [Channel_Internal_Height], Channel_Length_Units);

if(Base_Top_or_Both != "Top")
color_this(Global_Color)
        left(Show_Attached ? 0 : channelWidth/2+5)
            straightChannelBase(lengthMM = Channel_Length_Units * Grid_Size, widthMM = channelWidth, anchor=BOT);
if(Base_Top_or_Both != "Base")
color_this(Global_Color)
        right(Show_Attached ? 0 : channelWidth/2+5)
        up(Show_Attached ? interlockFromFloor : Add_Label ? 0.01 : 0)
            diff("text")
            straightChannelTop(lengthMM = Channel_Length_Units * Grid_Size, widthMM = channelWidth * topScaling, heightMM = Channel_Internal_Height, anchor=Show_Attached ? BOT : TOP, orient=Show_Attached ? TOP : BOT)
                if(Add_Label) tag("text") recolor(Text_Color) zrot(-90) attach(TOP) //linear_extrude(height = 0.02)
                right(Text_x_coordinate)text3d(Text, size = Text_size, h=Text_Depth > 0.05 ? Text_Depth : 0.05, font = surname_font, atype="ycenter", anchor=CENTER);

/*

***BEGIN MODULES***

*/

//STRAIGHT CHANNELS
module straightChannelBase(lengthMM, widthMM, anchor, spin, orient){
    attachable(anchor, spin, orient, size=[widthMM, lengthMM, baseHeight]){
        fwd(lengthMM/2) down(maxY(selectBaseProfile)/2)
        diff("holes")
        zrot(90) path_sweep(baseProfile(widthMM = widthMM), turtle(["xmove", lengthMM]))
        tag("holes")  right(lengthMM/2) grid_copies(spacing=Grid_Size, inside=rect([lengthMM-1,Grid_Size*Channel_Width_in_Units-1])) 
            mount_point();
    children();
    }
}

module mount_point() {
    underware_mount_cutout(
        Mounting_Method, Base_Screw_Hole_Inner_Diameter, Base_Screw_Hole_Outer_Diameter,
        Base_Screw_Hole_Inner_Depth, Magnet_Diameter, Magnet_Thickness, Magnet_Tolerance,
        Wood_Screw_Thread_Diameter, Wood_Screw_Head_Diameter, Wood_Screw_Head_Height,
        Outer_Diameter_Sm, 6, Pitch_Sm, Flank_Angle_Sm, Thread_Depth_Sm, Slop,
        MultipointBase_Screw_Hole_Outer_Diameter, Base_Screw_Hole_Cone
    );
}

module straightChannelTop(lengthMM, widthMM, heightMM = 12, anchor, spin, orient){
    attachable(anchor, spin, orient, size=[widthMM, lengthMM, topHeight + (heightMM-12)]){
        fwd(lengthMM/2) down(10.968/2 + (heightMM - 12)/2)
        diff("Cable_Cutouts")
        zrot(90) 
        path_sweep(
            topProfile(
                widthMM = widthMM, 
                heightMM = heightMM
                ), turtle(["xmove", lengthMM]))
            tag("Cable_Cutouts") down(5+0.01) up(10.968/2 + (heightMM - 12)/2) right(lengthMM/2)
                xcopies(n=Number_of_Cord_Cutouts, spacing= Distance_Between_Cutouts) 
                    up(2.49)
                    fwd(Cord_Side_Cutouts == "Left Side" ? widthMM/2 :
                        Cord_Side_Cutouts == "Right Side" ? -widthMM/2 : 
                        0)
                    left(-Shift_Cutouts_Forward_or_Back)
                        cuboid([Cord_Cutout_Width, Cord_Side_Cutouts == "Both Sides" ? widthMM + 5 : widthMM/2, Channel_Internal_Height-2], chamfer = 2, edges=[TOP+LEFT, TOP+RIGHT]);
    children();
    }
}

include <underware_profiles.scad>



