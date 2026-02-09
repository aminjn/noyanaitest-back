const makeTaminRequest: (args: {
  path: string;
  method: "GET" | "POST";
  payload?: unknown;
  token: string;
  parser?: "JSON" | "PARAMS";
}) => Promise<Response> = async ({
  method,
  path: _path,
  token,
  payload,
  parser = "JSON",
}) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  let body: string | undefined;
  let path = _path;
  switch (parser) {
    case "JSON":
      headers["Content-Type"] = "application/json";
      body = payload ? JSON.stringify(payload) : undefined;
      break;
    case "PARAMS":
      const params = new URLSearchParams();
      if (payload && typeof payload === "object")
        for (const key in payload)
          params.append(key, String((payload as any)[key]));
      path += `?${params.toString()}`;
      break;
  }
  console.log({ path, method, body, headers });
  return await fetch(`${path}`, {
    method,
    body,
    headers,
  });
};
export default makeTaminRequest;
