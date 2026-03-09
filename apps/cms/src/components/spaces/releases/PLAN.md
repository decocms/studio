# Releases Space

## Overview

The Releases space manages git-based versioning and deployments. It shows the git status, allows creating releases (commits), and managing branches/environments.

## Features

- **Git Status** - Show changed files (staged, unstaged)
- **Commit Changes** - Create releases with commit messages
- **Release History** - List of past releases with diffs
- **Branches** - View and switch environments
- **Rebase** - Sync with upstream changes
- **Discard** - Revert changes to files

## Components

### ReleasesList.tsx

Main releases view showing git status and history.

```tsx
export function ReleasesList() {
  const { changeset, env } = useDaemon();
  const { data: releases } = useReleases();
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  
  const status = changeset.get();
  const hasChanges = status?.staged.length > 0 || status?.unstaged.length > 0;
  
  return (
    <SpaceContainer title="Releases">
      {/* Current changes section */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Current Changes</CardTitle>
          <CardDescription>
            {hasChanges 
              ? `${status.staged.length + status.unstaged.length} file(s) changed`
              : 'No uncommitted changes'
            }
          </CardDescription>
        </CardHeader>
        <CardContent>
          {hasChanges && (
            <>
              <FileChangesList 
                files={[...status.staged, ...status.unstaged]}
                selected={selectedFiles}
                onSelect={setSelectedFiles}
              />
              <div className="flex gap-2 mt-4">
                <Button onClick={() => openCommitDialog()}>
                  Commit Changes
                </Button>
                <Button 
                  variant="outline" 
                  onClick={() => discardChanges(selectedFiles)}
                >
                  Discard Selected
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      
      {/* Release history */}
      <Card>
        <CardHeader>
          <CardTitle>Release History</CardTitle>
        </CardHeader>
        <CardContent>
          <ReleasesTable releases={releases} />
        </CardContent>
      </Card>
    </SpaceContainer>
  );
}
```

### CommitDialog.tsx

Modal for creating a new release/commit.

```tsx
interface CommitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: FileChange[];
}

export function CommitDialog({ open, onOpenChange, files }: CommitDialogProps) {
  const [message, setMessage] = useState('');
  const createRelease = useCreateRelease();
  
  const handleCommit = async () => {
    await createRelease.mutateAsync({
      message,
      files: files.map(f => f.path),
    });
    onOpenChange(false);
  };
  
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Release</DialogTitle>
          <DialogDescription>
            Commit {files.length} changed file(s)
          </DialogDescription>
        </DialogHeader>
        
        <div className="space-y-4">
          <div>
            <Label>Commit Message</Label>
            <Textarea 
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Describe your changes..."
            />
          </div>
          
          <div>
            <Label>Files to commit</Label>
            <div className="max-h-40 overflow-auto border rounded p-2">
              {files.map(file => (
                <div key={file.path} className="text-sm flex items-center gap-2">
                  <FileStatusBadge status={file.status} />
                  <span>{file.path}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
        
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCommit} disabled={!message.trim()}>
            Commit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### ReleaseDetail.tsx

View details of a specific release with diff.

```tsx
export function ReleaseDetail({ releaseId }: { releaseId: string }) {
  const { data: release } = useRelease(releaseId);
  const { data: diff } = useReleaseDiff(releaseId);
  
  return (
    <SpaceContainer>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">{release?.message}</h1>
        <div className="text-muted-foreground">
          {release?.author} • {formatDate(release?.timestamp)}
        </div>
      </div>
      
      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="files">Changed Files</TabsTrigger>
          <TabsTrigger value="diff">Diff</TabsTrigger>
        </TabsList>
        
        <TabsContent value="files">
          <FileChangesList files={release?.files || []} />
        </TabsContent>
        
        <TabsContent value="diff">
          <DiffViewer diff={diff} />
        </TabsContent>
      </Tabs>
    </SpaceContainer>
  );
}
```

### RebaseButton.tsx

Button to sync environment with upstream.

```tsx
export function RebaseButton() {
  const { env, changeset } = useDaemon();
  const [isRebasing, setIsRebasing] = useState(false);
  
  const handleRebase = async () => {
    setIsRebasing(true);
    try {
      await changeset.rebase(env.name);
      toast.success('Successfully synced with upstream');
    } catch (error) {
      toast.error('Rebase failed. Please resolve conflicts.');
    } finally {
      setIsRebasing(false);
    }
  };
  
  return (
    <Button 
      variant="outline" 
      onClick={handleRebase}
      disabled={isRebasing}
    >
      {isRebasing ? <Spinner /> : <RefreshCw className="h-4 w-4 mr-2" />}
      Sync
    </Button>
  );
}
```

## Hooks

### use-releases.ts

```tsx
// Get git status
export function useGitStatus() {
  const { changeset } = useDaemon();
  return useQuery({
    queryKey: ['git-status'],
    queryFn: () => changeset.sync(),
    refetchInterval: 10000,
  });
}

// List releases/commits
export function useReleases() {
  const { site, env } = useSite();
  return useQuery({
    queryKey: ['releases', site.name, env.name],
    queryFn: () => api.releases.list({ site: site.name, env: env.name }),
  });
}

// Get release diff
export function useReleaseDiff(releaseId: string) {
  const { site, env } = useSite();
  return useQuery({
    queryKey: ['release-diff', releaseId],
    queryFn: () => api.releases.diff({ site: site.name, env: env.name, releaseId }),
    enabled: !!releaseId,
  });
}

// Create release mutation
export function useCreateRelease() {
  const { site, env } = useSite();
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (data: { message: string; files: string[] }) => 
      api.releases.create({ site: site.name, env: env.name, ...data }),
    onSuccess: () => {
      queryClient.invalidateQueries(['releases']);
      queryClient.invalidateQueries(['git-status']);
    },
  });
}

// Discard changes mutation
export function useDiscardChanges() {
  const { changeset } = useDaemon();
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (files: string[]) => changeset.discardChanges(files),
    onSuccess: () => {
      queryClient.invalidateQueries(['git-status']);
      queryClient.invalidateQueries(['blocks']);
    },
  });
}
```

## Porting from admin-cx

Reference files:
- `admin-cx/components/spaces/siteEditor/extensions/Git/views/Releases/Releases.tsx`
- `admin-cx/components/spaces/siteEditor/extensions/Git/views/Summary.tsx`
- `admin-cx/components/spaces/siteEditor/extensions/Git/components/RebaseButton.tsx`
- `admin-cx/loaders/releases/git/*.ts`
- `admin-cx/actions/releases/git/*.ts`

