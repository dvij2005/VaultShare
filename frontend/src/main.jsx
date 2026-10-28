
import React from "react";
import ReactDOM from "react-dom/client";
import { AuthProvider } from "react-oidc-context";
import App from "./App";
import "./App.css";

const cognitoAuthConfig = {
  authority:
    "https://cognito-idp.ap-south-2.amazonaws.com/ap-south-2_R1EmaHx02",

  client_id: import.meta.env.VITE_COGNITO_CLIENT_ID,

  redirect_uri: import.meta.env.VITE_COGNITO_REDIRECT_URI,

  post_logout_redirect_uri: import.meta.env.VITE_COGNITO_REDIRECT_URI,

  response_type: "code",

  scope: "openid email profile",

  onSigninCallback: () => {
    window.history.replaceState(
      {},
      document.title,
      window.location.pathname
    );
  }
};

const root = ReactDOM.createRoot(
  document.getElementById("root")
);

root.render(
  <React.StrictMode>
    <AuthProvider {...cognitoAuthConfig}>
      <App />
    </AuthProvider>
  </React.StrictMode>
);
