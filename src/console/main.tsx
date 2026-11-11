import { createRoot } from "react-dom/client";

import App from "./App.js";
import { Boundary } from "./Boundary.js";
import { connect } from "./store.js";

connect();
createRoot(document.getElementById("root")!).render(<Boundary><App /></Boundary>);
