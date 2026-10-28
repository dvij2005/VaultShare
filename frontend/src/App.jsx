
import { useEffect, useRef, useState } from "react";
import {
  ShieldCheck,
  Files,
  Search,
  Plus,
  FileText,
  FileImage,
  FileArchive,
  Download,
  CheckCircle2,
  X,
  LockKeyhole,
  Video,
  HardDrive,
  Share2,
  Users,
  Send
} from "lucide-react";
import "./App.css";
import { useAuth } from "react-oidc-context";

const API_URL = import.meta.env.VITE_API_URL || (import.meta.env.DEV ? "http://localhost:5000" : "");

const COGNITO_LOGOUT_URL =
  "https://ap-south-2r1emahx02.auth.ap-south-2.amazoncognito.com/logout";

function formatFile(file) {
  const ext = file.name.split(".").pop().toLowerCase();

  let type = "pdf";

  if (["png", "jpg", "jpeg"].includes(ext)) type = "image";
  if (ext === "zip") type = "zip";

  if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) {
    type = "video";
  }

  const size =
    file.sizeBytes < 1024 * 1024
      ? `${(file.sizeBytes / 1024).toFixed(0)} KB`
      : `${(file.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;

  return {
    id: file.id,
    name: file.name,
    type,
    size,
    sizeBytes: file.sizeBytes,
    date: new Date(file.uploadedAt).toLocaleString(),
    owner: "You"
  };
}

function App() {
  const auth = useAuth();

  const [files, setFiles] = useState([]);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [sharedFiles, setSharedFiles] = useState([]);
  const [isLoadingShared, setIsLoadingShared] = useState(false);
  const [currentView, setCurrentView] = useState("mine");
  const [shareTarget, setShareTarget] = useState(null);
  const [shareEmail, setShareEmail] = useState("");
  const [isSharing, setIsSharing] = useState(false);

  const fileInput = useRef(null);

  async function authenticatedFetch(url, options = {}) {
    const token = auth.user?.access_token;

    if (!token) {
      throw new Error("No access token found. Please sign in again.");
    }

    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);

    return fetch(url, {
      ...options,
      headers
    });
  }

  const currentFiles = currentView === "mine" ? files : sharedFiles;
  const visibleFiles = currentFiles.filter((file) =>
    file.name.toLowerCase().includes(search.toLowerCase())
  );

  const totalBytes = files.reduce(
    (total, file) => total + (file.sizeBytes || 0),
    0
  );

  const storageMB = (totalBytes / (1024 * 1024)).toFixed(2);

  const videoCount = files.filter(
    (file) => file.type === "video"
  ).length;

  const otherFileCount = files.length - videoCount;

  useEffect(() => {
    if (auth.isLoading || !auth.isAuthenticated || !auth.user) {
      return;
    }

    let cancelled = false;

    async function loadFiles() {
      try {
        const response = await authenticatedFetch(`${API_URL}/api/files`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || "Could not load files.");
        }

        if (!cancelled) {
          setFiles((data.files || []).map(formatFile));
          setNotice("");
        }
      } catch (error) {
        if (!cancelled) {
          setNotice(`Could not load files: ${error.message}`);
        }
      }
    }

    loadFiles();

    return () => {
      cancelled = true;
    };
  }, [auth.isLoading, auth.isAuthenticated, auth.user]);

  async function loadSharedFiles() {
    try {
      setIsLoadingShared(true);
      const response = await authenticatedFetch(`${API_URL}/api/shared-with-me`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not load shared files.");
      setSharedFiles((data.files || []).map((file) => ({
        ...formatFile(file),
        shareId: file.shareId,
        owner: `Owner ${file.ownerId.slice(0, 8)}`
      })));
    } catch (error) {
      setNotice(`Could not load shared files: ${error.message}`);
    } finally {
      setIsLoadingShared(false);
    }
  }

  async function handleShareSubmit(event) {
    event.preventDefault();
    if (!shareTarget) return;
    try {
      setIsSharing(true);
      const response = await authenticatedFetch(
        `${API_URL}/api/files/${encodeURIComponent(shareTarget.id)}/share`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: shareEmail }) }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Could not share file.");
      setNotice(data.message || "File shared successfully.");
      setShareTarget(null);
      setShareEmail("");
    } catch (error) {
      setNotice(`Sharing failed: ${error.message}`);
    } finally {
      setIsSharing(false);
    }
  }

  async function handleDownload(file) {
    try {
      const downloadPath = currentView === "mine"
        ? `/api/files/${encodeURIComponent(file.id)}/download`
        : `/api/shared-with-me/${encodeURIComponent(file.shareId)}/download`;
      const response = await authenticatedFetch(`${API_URL}${downloadPath}`);

      if (!response.ok) {
        let message = "Download failed.";

        try {
          const data = await response.json();
          message = data.message || message;
        } catch {
          // Keep the default message if the response isn't JSON.
        }

        throw new Error(message);
      }

      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = downloadUrl;
      link.download = file.name;
      document.body.appendChild(link);
      link.click();
      link.remove();

      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    } catch (error) {
      setNotice(`Download failed: ${error.message}`);
    }
  }

  async function handleUpload(event) {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";

    if (selected.length === 0) return;

    const formData = new FormData();

    selected.forEach((file) => {
      formData.append("files", file);
    });

    try {
      setIsUploading(true);
      setNotice("Uploading files...");

      const response = await authenticatedFetch(
        `${API_URL}/api/files/upload`,
        {
          method: "POST",
          body: formData
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Upload failed.");
      }

      const listResponse = await authenticatedFetch(
        `${API_URL}/api/files`
      );

      const listData = await listResponse.json();

      if (!listResponse.ok) {
        throw new Error(
          "Upload succeeded, but refreshing the file list failed."
        );
      }

      setFiles((listData.files || []).map(formatFile));
      setNotice(data.message || "Upload completed successfully.");
    } catch (error) {
      setNotice(`Upload failed: ${error.message}`);
    } finally {
      setIsUploading(false);
    }
  }

  function fileIcon(type) {
    if (type === "image") return <FileImage size={20} />;
    if (type === "zip") return <FileArchive size={20} />;
    if (type === "video") return <Video size={20} />;

    return <FileText size={20} />;
  }

  async function handleSignOut() {
    if (isSigningOut) return;

    setIsSigningOut(true);

    try {
      const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID;

      if (!clientId) {
        throw new Error("Cognito client ID is missing from frontend/.env.");
      }

      // Clear the local OIDC session first so React cannot keep showing
      // the authenticated files page after the redirect.
      await auth.removeUser();

      const logoutUrl = new URL(COGNITO_LOGOUT_URL);

      logoutUrl.searchParams.set("client_id", clientId);
      logoutUrl.searchParams.set(
        "logout_uri",
        `${window.location.origin}/`
      );

      window.location.replace(logoutUrl.toString());
    } catch (error) {
      setIsSigningOut(false);
      setNotice(`Sign-out failed: ${error.message}`);
    }
  }

  if (auth.isLoading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0b0f17",
          color: "#ffffff"
        }}
      >
        Checking your VaultShare session...
      </div>
    );
  }

  if (auth.error) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0b0f17",
          color: "#ffffff"
        }}
      >
        <div>
          <h2>Authentication error</h2>
          <p>{auth.error.message}</p>
          <button onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#0b0f17",
          color: "#ffffff",
          fontFamily: "Arial, sans-serif"
        }}
      >
        <div
          style={{
            width: "min(420px, 85vw)",
            padding: "36px",
            border: "1px solid #263247",
            borderRadius: "16px",
            background: "#101722",
            textAlign: "center"
          }}
        >
          <h1>VaultShare</h1>
          <p>Secure digital file exchange</p>
          <p>Sign in or create an account to continue.</p>

          <button
            className="primary-button"
            onClick={() => auth.signinRedirect()}
          >
            Sign in / Sign up
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <ShieldCheck size={25} />
          </div>

          <div>
            <h2>VaultShare</h2>
            <span>SECURE FILE EXCHANGE</span>
          </div>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <nav className="nav-menu">
          <button className={`nav-item ${currentView === "mine" ? "active" : ""}`} onClick={() => { setCurrentView("mine"); setSearch(""); }}>
            <Files size={19} /> My files <span className="nav-count">{files.length}</span>
          </button>
          <button className={`nav-item ${currentView === "shared" ? "active" : ""}`} onClick={() => { setCurrentView("shared"); setSearch(""); loadSharedFiles(); }}>
            <Users size={19} /> Shared with me <span className="nav-count">{sharedFiles.length}</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="profile">
            <div className="avatar">
              {(auth.user?.profile?.email || "V")
                .slice(0, 1)
                .toUpperCase()}
            </div>

            <div className="profile-info">
              <strong>
                {auth.user?.profile?.email || "VaultShare User"}
              </strong>
              <span>Signed in</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <span>/</span> {currentView === "mine" ? "My Files" : "Shared with me"}
          </div>

          <div className="top-actions">
            <button
              className="icon-button"
              title="Sign out"
              disabled={isSigningOut}
              onClick={handleSignOut}
            >
              {isSigningOut ? "Signing out..." : "Sign out"}
            </button>
          </div>
        </header>

        <section className="page-content">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">
                <LockKeyhole size={14} />
                YOUR FILES, UNDER YOUR CONTROL
              </div>

              <h1>{currentView === "mine" ? "My files" : "Shared with me"}</h1>

              <p className="subtitle">
                {currentView === "mine" ? "Upload, organize, share, and download your documents and videos." : "Files other VaultShare users have shared with you."}
              </p>
            </div>

            {currentView === "mine" && <button
              className="primary-button"
              disabled={isUploading}
              onClick={() => fileInput.current?.click()}
            >
              <Plus size={19} />
              {isUploading ? "Uploading..." : "Upload files"}
            </button>}

            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg,.zip,.mp4,.webm,.mov,.avi,.mkv"
              onChange={handleUpload}
            />
          </div>

          {notice && (
            <div className="notice">
              <CheckCircle2 size={18} />
              <span>{notice}</span>

              <button
                onClick={() => setNotice("")}
                aria-label="Dismiss"
              >
                <X size={17} />
              </button>
            </div>
          )}

          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-top">
                <span>Total files</span>
                <div className="stat-icon blue">
                  <Files size={19} />
                </div>
              </div>
              <h2>{files.length}</h2>
              <p>Files in your account</p>
            </div>

            <div className="stat-card">
              <div className="stat-top">
                <span>Storage used</span>
                <div className="stat-icon purple">
                  <HardDrive size={19} />
                </div>
              </div>
              <h2>
                {storageMB} <small>MB</small>
              </h2>
              <p>Total size of stored files</p>
            </div>

            <div className="stat-card">
              <div className="stat-top">
                <span>Videos</span>
                <div className="stat-icon green">
                  <Video size={19} />
                </div>
              </div>
              <h2>{videoCount}</h2>
              <p>Videos in your account</p>
            </div>

            <div className="stat-card">
              <div className="stat-top">
                <span>Other files</span>
                <div className="stat-icon orange">
                  <FileText size={19} />
                </div>
              </div>
              <h2>{otherFileCount}</h2>
              <p>Documents, images, and archives</p>
            </div>
          </div>

          <section className="files-panel">
            <div className="panel-header">
              <div>
                <h3>{currentView === "mine" ? "File manager" : "Files shared with you"}</h3>
                <p>{currentView === "mine" ? "Your workspace files and documents" : "You can view and download these files."}</p>
              </div>

              <div className="search-box">
                <Search size={17} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search files..."
                  aria-label="Search files"
                />
              </div>
            </div>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>NAME</th>
                    <th>SIZE</th>
                    <th>LAST MODIFIED</th>
                    <th>{currentView === "mine" ? "OWNER" : "SHARED FILE"}</th>
                    <th />
                  </tr>
                </thead>

                <tbody>
                  {isLoadingShared && currentView === "shared" && (
                    <tr>
                      <td colSpan="5" className="empty-state">Loading shared files...</td>
                    </tr>
                  )}

                  {!isLoadingShared && visibleFiles.map((file) => (
                    <tr key={file.id}>
                      <td>
                        <div className={`file-icon ${file.type}`}>
                          {fileIcon(file.type)}
                        </div>
                        <span className="file-name">{file.name}</span>
                      </td>

                      <td>{file.size}</td>
                      <td>{file.date}</td>

                      <td>
                        <span className="owner-tag">{file.owner}</span>
                      </td>

                      <td className="action-cell">
                        {currentView === "mine" && <button className="row-action" title="Share file" onClick={() => { setShareTarget(file); setShareEmail(""); }}><Share2 size={18} /></button>}
                        <button className="row-action" title="Download file" onClick={() => handleDownload(file)}><Download size={18} /></button>
                      </td>
                    </tr>
                  ))}

                  {!isLoadingShared && visibleFiles.length === 0 && (
                    <tr>
                      <td colSpan="5" className="empty-state">
                        {search ? "No matching files found." : currentView === "mine" ? "No files uploaded yet." : "No files have been shared with you yet."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="panel-footer">
              <span>
                Showing {visibleFiles.length} of {currentFiles.length} files
              </span>

              <button
                className="text-button"
                onClick={() => setSearch("")}
              >
                Clear search
              </button>
            </div>
          </section>

          {shareTarget && (
            <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShareTarget(null); }}>
              <section className="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
                <div className="share-modal-heading">
                  <div><h2 id="share-title">Share file</h2><p>{shareTarget.name}</p></div>
                  <button className="row-action" aria-label="Close" onClick={() => setShareTarget(null)}><X size={20} /></button>
                </div>
                <form onSubmit={handleShareSubmit}>
                  <label htmlFor="recipient-email">Recipient's registered email</label>
                  <input id="recipient-email" type="email" required value={shareEmail} onChange={(event) => setShareEmail(event.target.value)} placeholder="name@example.com" />
                  <div className="share-permission"><LockKeyhole size={16} /><span>View and download only</span></div>
                  <div className="share-modal-actions">
                    <button type="button" className="secondary-button" onClick={() => setShareTarget(null)}>Cancel</button>
                    <button type="submit" className="primary-button" disabled={isSharing}><Send size={16} />{isSharing ? "Sharing..." : "Share file"}</button>
                  </div>
                </form>
              </section>
            </div>
          )}

          <footer className="page-footer">
            <span>
              <ShieldCheck size={15} />
              VaultShare · Secure Digital File Exchange
            </span>
          </footer>
        </section>
      </main>
    </div>
  );
}

export default App;
