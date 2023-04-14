export function waitForChannel(peer: RTCPeerConnection, label: string) {
  return new Promise<RTCDataChannel>((resolve) => {
    const handler = (ev: RTCDataChannelEvent) => {
      if (ev.channel.label === label) {
        peer.removeEventListener("datachannel", handler);
        resolve(ev.channel);
      }
    };

    peer.addEventListener("datachannel", handler);
  });
}

export function waitForConnectionState(
  peer: RTCPeerConnection,
  state: RTCPeerConnection["connectionState"]
) {
  return new Promise<void>((resolve) => {
    const handler = () => {
      if (peer.connectionState === state) {
        peer.removeEventListener("connectionstatechange", handler);
        resolve();
      }
    };

    if (peer.connectionState === state) {
      resolve();
    } else {
      peer.addEventListener("connectionstatechange", handler);
    }
  });
}

export async function establishConnection({
  from,
  to,
}: {
  from: RTCPeerConnection;
  to: RTCPeerConnection;
}): Promise<{ from: RTCDataChannel; to: RTCDataChannel }> {
  from.addEventListener("icecandidate", async (ev) => {
    if (ev.candidate) {
      await to.addIceCandidate(ev.candidate);
    }
  });

  to.addEventListener("icecandidate", async (ev) => {
    if (ev.candidate) {
      await from.addIceCandidate(ev.candidate);
    }
  });

  const tx = from.createDataChannel("channel");
  const rxPromise = waitForChannel(to, "channel");

  const offer = await from.createOffer();

  await from.setLocalDescription(offer);
  await to.setRemoteDescription(offer);

  const answer = await to.createAnswer();

  await to.setLocalDescription(answer);
  await from.setRemoteDescription(answer);

  await waitForConnectionState(from, "connected");
  await waitForConnectionState(to, "connected");

  const rx = await rxPromise;

  return {
    from: tx,
    to: rx,
  };
}
