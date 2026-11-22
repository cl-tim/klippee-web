import { Group, Text } from "@mantine/core";

const version = "v0.3.0";
const release = `https://github.com/cl-tim/hlab/releases/download/${version}`;
const linux = [
  { label: "Linux ARM64", asset: "hlab-linux-arm64" },
  { label: "Linux ARM (32-bit)", asset: "hlab-linux-arm" },
  { label: "Linux x64", asset: "hlab-linux-amd64" },
];
const downloads = {
  printer: linux,
  windows: [{ label: "Windows x64", asset: "hlab-windows-amd64.exe" }],
  unix: [
    { label: "macOS Apple silicon", asset: "hlab-darwin-arm64" },
    { label: "macOS Intel", asset: "hlab-darwin-amd64" },
    ...linux,
  ],
};

export function HlabReleaseDownloads({ platform }: { platform: keyof typeof downloads }) {
  return (
    <div>
      <Text size="sm">
        Download hlab {version}, then {platform === "windows"
          ? <>save it as <code>hlab.exe</code></>
          : <>save it as <code>hlab</code> and make it executable</>}.
        {" "}Put it on your PATH before running setup.
      </Text>
      <Group gap="xs" wrap="wrap">
        {downloads[platform].map(({ label, asset }) => (
          <a key={asset} href={`${release}/${asset}`}>{label}</a>
        ))}
        <a href={`${release}/SHA256SUMS`}>SHA-256 checksums</a>
      </Group>
    </div>
  );
}
