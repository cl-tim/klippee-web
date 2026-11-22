// Shared original and v2.5 channel profiles.
// Include this file after Profile_Type, Channel_Internal_Height,
// Additional_Holding_Strength, and topHeight are defined.

selectTopProfile = Profile_Type == "Original"
    ? topProfileHalf(Channel_Internal_Height)
    : topProfileInverseHalf(Channel_Internal_Height);
selectBaseProfile = Profile_Type == "Original"
    ? baseProfileHalf()
    : baseProfileInverseHalf();

function baseProfile(widthMM = 25) =
    union(
        left((widthMM-25)/2, selectBaseProfile),
        right((widthMM-25)/2, mirror([1,0], selectBaseProfile)),
        back(3.5/2, rect([widthMM-25+0.02,3.5]))
    );

function topProfile(widthMM = 25, heightMM = 12) =
    union(
        left((widthMM-25)/2, selectTopProfile),
        right((widthMM-25)/2, mirror([1,0], selectTopProfile)),
        back(topHeight-1 + heightMM-12, rect([widthMM-25+0.02,2]))
    );

function baseDeleteProfile(widthMM = 25) =
    union(
        left((widthMM-25)/2, baseDeleteProfileHalf),
        right((widthMM-25)/2, mirror([1,0], baseDeleteProfileHalf)),
        back(6.575, rect([widthMM-25+0.02,6.15]))
    );

function topDeleteProfile(widthMM, heightMM = 12) =
    union(
        left((widthMM-25)/2, topDeleteProfileHalf(heightMM)),
        right((widthMM-25)/2, mirror([1,0], topDeleteProfileHalf(heightMM))),
        back(
            4.474 + (heightMM-12-Additional_Holding_Strength)/2,
            rect([widthMM-25+0.02,8.988+heightMM-12+Additional_Holding_Strength])
        )
    );

function baseProfileHalf() =
    fwd(-7.947, [
        [0,-4.447],
        [-8.5+Additional_Holding_Strength*1.5,-4.447],
        [-9.5+Additional_Holding_Strength*1.5,-3.447],
        [-9.5+Additional_Holding_Strength*1.5,1.683],
        [-10.517+Additional_Holding_Strength/2,1.683],
        [-11.459+Additional_Holding_Strength/2,1.422],
        [-11.459+Additional_Holding_Strength/2,-0.297],
        [-11.166+Additional_Holding_Strength*1.5,-0.592-Additional_Holding_Strength/2],
        [-11.166+Additional_Holding_Strength*1.5,-1.414-Additional_Holding_Strength],
        [-11.666+Additional_Holding_Strength,-1.914-Additional_Holding_Strength],
        [-12.517,-1.914-Additional_Holding_Strength],
        [-12.517,-4.448],
        [-10.517,-6.448],
        [-10.517,-7.947],
        [0,-7.947]
    ]);

baseDeleteProfileHalf =
    fwd(-7.947, [
        [0,-4.447],
        [0,1.703],
        [-9.5+Additional_Holding_Strength*1.5,1.703],
        [-9.5+Additional_Holding_Strength*1.5,-3.447],
        [-8.5+Additional_Holding_Strength*1.5,-4.447]
    ]);

topChamfer = Additional_Holding_Strength < 0.4 ? 0 : 1;

function topProfileHalf(heightMM = 12) =
    let(chamfer = Additional_Holding_Strength < 0.4 ? 0 : 1)
    back(1.414, [
        [0,7.554+heightMM-12],
        [0,9.554+heightMM-12],
        [-8.517,9.554+heightMM-12],
        [-12.517,5.554+heightMM-12],
        [-12.517,-1.414-Additional_Holding_Strength],
        [-11.166+Additional_Holding_Strength*1.5-chamfer,-1.414-Additional_Holding_Strength],
        [-11.166+Additional_Holding_Strength*1.5,-0.592-Additional_Holding_Strength/2],
        [-11.459+Additional_Holding_Strength/2,-0.297],
        [-11.459+Additional_Holding_Strength/2,1.422],
        [-10.517+Additional_Holding_Strength/2,1.683],
        [-10.517+Additional_Holding_Strength/2,4.725+heightMM-12],
        [-7.688,7.554+heightMM-12]
    ]);

function topDeleteProfileHalf(heightMM = 12) =
    back(1.414, [
        [0.1,7.554+heightMM-12],
        [-7.688,7.554+heightMM-12],
        [-10.517+Additional_Holding_Strength/2,4.725+heightMM-12],
        [-10.517+Additional_Holding_Strength/2,1.683],
        [-11.459+Additional_Holding_Strength/2,1.422],
        [-11.459+Additional_Holding_Strength/2,-0.297],
        [-11.166+Additional_Holding_Strength*1.5,-0.592-Additional_Holding_Strength/2],
        [-11.166+Additional_Holding_Strength*1.5-topChamfer,-1.434-Additional_Holding_Strength],
        [0.1,-1.434-Additional_Holding_Strength]
    ]);

function topProfileInverseHalf(heightMM = 12) =
    let(snapWallThickness=1, snapCaptureStrength=0.5)
    back(1.414, [
        [0,7.554+heightMM-12],
        [0,9.554+heightMM-12],
        [-8.517,9.554+heightMM-12],
        [-12.5,5.554+heightMM-12],
        [-12.5,2],
        [-11.5+snapWallThickness,1.8],
        [-11.5+snapWallThickness,-0.3],
        [-11.8+snapWallThickness-snapCaptureStrength,-0.6],
        [-11.8+snapWallThickness-snapCaptureStrength,-1.4],
        [-10.5+snapWallThickness-snapCaptureStrength,-2],
        [-10.5+snapWallThickness*1.5,-2],
        [-10.5+snapWallThickness*1.5,4.725+heightMM-12],
        [-7.688+snapWallThickness*1.5,7.554+heightMM-12]
    ]);

function baseProfileInverseHalf() =
    let(snapWallThickness=1, snapCaptureStrength=0.5, baseChamfer=0.5)
    fwd(-7.947, [
        [0,-4.447],
        [-8.5,-4.447],
        [-10+snapWallThickness,-3.447],
        [-10+snapWallThickness,-2.4],
        [-11.8+snapWallThickness-snapCaptureStrength,-2.4],
        [-11.8+snapWallThickness-snapCaptureStrength,-0.6],
        [-11.5+snapWallThickness,-0.3],
        [-11.5+snapWallThickness,1.4-baseChamfer],
        [-11.7,1.683],
        [-12.5,1.683],
        [-12.5,-4.448],
        [-10.5,-6.448],
        [-10.5,-7.947],
        [0,-7.947]
    ]);

function maxX(path) = max([for (p=path) p[0]]) + abs(min([for (p=path) p[0]]));
function maxY(path) = max([for (p=path) p[1]]) + abs(min([for (p=path) p[1]]));
