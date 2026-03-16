# Settings Space

## Overview

The Settings space provides configuration options for the site, including domains, team management, hosting options, and danger zone operations.

## Settings Sections

1. **General** - Site name, description, visibility
2. **Domains** - Custom domain management
3. **Hosting** - Environment configuration
4. **Team** - Members and permissions
5. **Integrations** - External service connections
6. **Danger Zone** - Delete site, transfer ownership

## Components

### SettingsOverview.tsx

Main settings page with section navigation.

```tsx
export function SettingsOverview() {
  const { site } = useSite();
  
  return (
    <SpaceContainer title="Settings">
      <div className="grid gap-6">
        {/* General Settings */}
        <SettingsSection 
          title="General" 
          description="Basic site information"
          href="general"
        >
          <GeneralSettingsPreview site={site} />
        </SettingsSection>
        
        {/* Domains */}
        <SettingsSection 
          title="Domains" 
          description="Custom domain configuration"
          href="domains"
        >
          <DomainsPreview site={site} />
        </SettingsSection>
        
        {/* Team */}
        <SettingsSection 
          title="Team" 
          description="Manage team members and permissions"
          href="team"
        >
          <TeamPreview />
        </SettingsSection>
        
        {/* Danger Zone */}
        <SettingsSection 
          title="Danger Zone" 
          description="Irreversible actions"
          variant="danger"
        >
          <DangerZonePreview />
        </SettingsSection>
      </div>
    </SpaceContainer>
  );
}
```

### DomainsSettings.tsx

Custom domain management.

```tsx
export function DomainsSettings() {
  const { site } = useSite();
  const { data: domains, isLoading } = useDomains();
  const addDomain = useAddDomain();
  const removeDomain = useRemoveDomain();
  
  return (
    <SpaceContainer title="Domains">
      <Card>
        <CardHeader>
          <CardTitle>Custom Domains</CardTitle>
          <CardDescription>
            Add custom domains to your site
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Default domain */}
          <div className="mb-4 p-3 bg-muted rounded flex items-center justify-between">
            <div>
              <span className="font-mono text-sm">{site.name}.deco.site</span>
              <Badge className="ml-2">Default</Badge>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <a href={`https://${site.name}.deco.site`} target="_blank">
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
          
          {/* Custom domains list */}
          <div className="space-y-2">
            {domains?.map(domain => (
              <DomainRow 
                key={domain.hostname}
                domain={domain}
                onRemove={() => removeDomain.mutate(domain.hostname)}
              />
            ))}
          </div>
          
          {/* Add domain form */}
          <AddDomainForm onAdd={(hostname) => addDomain.mutate(hostname)} />
        </CardContent>
      </Card>
      
      {/* DNS Instructions */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>DNS Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <DNSInstructions />
        </CardContent>
      </Card>
    </SpaceContainer>
  );
}
```

### TeamSettings.tsx

Team member management.

```tsx
export function TeamSettings() {
  const { data: members, isLoading } = useTeamMembers();
  const inviteMember = useInviteMember();
  const removeMember = useRemoveMember();
  const updateRole = useUpdateMemberRole();
  
  return (
    <SpaceContainer title="Team">
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Team Members</CardTitle>
            <CardDescription>
              Manage who has access to this site
            </CardDescription>
          </div>
          <InviteMemberDialog onInvite={inviteMember.mutate} />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Added</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members?.map(member => (
                <TableRow key={member.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Avatar src={member.avatar} name={member.name} />
                      <div>
                        <div className="font-medium">{member.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {member.email}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <RoleSelector 
                      value={member.role}
                      onChange={(role) => updateRole.mutate({ id: member.id, role })}
                    />
                  </TableCell>
                  <TableCell>{formatDate(member.addedAt)}</TableCell>
                  <TableCell>
                    <Button 
                      variant="ghost" 
                      size="sm"
                      onClick={() => removeMember.mutate(member.id)}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </SpaceContainer>
  );
}
```

### DangerZone.tsx

Dangerous operations with confirmations.

```tsx
export function DangerZone() {
  const { site } = useSite();
  const deleteSite = useDeleteSite();
  const navigate = useNavigate();
  
  const handleDelete = async () => {
    const confirmed = await confirmDialog({
      title: 'Delete Site',
      description: `Are you sure you want to delete "${site.name}"? This action cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    
    if (confirmed) {
      await deleteSite.mutateAsync(site.name);
      navigate('/');
    }
  };
  
  return (
    <SpaceContainer title="Danger Zone">
      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="text-destructive">Delete Site</CardTitle>
          <CardDescription>
            Permanently delete this site and all its content. This action cannot be undone.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={handleDelete}>
            Delete Site
          </Button>
        </CardContent>
      </Card>
    </SpaceContainer>
  );
}
```

## Hooks

### use-settings.ts

```tsx
// Get domains
export function useDomains() {
  const { site } = useSite();
  return useQuery({
    queryKey: ['domains', site.name],
    queryFn: () => api.domains.list({ site: site.name }),
  });
}

// Add domain
export function useAddDomain() {
  const { site } = useSite();
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (hostname: string) => 
      api.domains.add({ site: site.name, hostname }),
    onSuccess: () => {
      queryClient.invalidateQueries(['domains']);
    },
  });
}

// Get team members
export function useTeamMembers() {
  const { site } = useSite();
  return useQuery({
    queryKey: ['team-members', site.name],
    queryFn: () => api.teams.members({ site: site.name }),
  });
}

// Delete site
export function useDeleteSite() {
  return useMutation({
    mutationFn: (siteName: string) => api.sites.delete({ site: siteName }),
  });
}
```

## Porting from admin-cx

Reference files:
- `admin-cx/components/settings/Settings.tsx`
- `admin-cx/components/settings/DomainSettings.tsx`
- `admin-cx/components/settings/DeleteSettings.tsx`
- `admin-cx/components/TeamMemberTable.tsx`
- `admin-cx/loaders/domains/*.ts`
- `admin-cx/actions/domains/*.ts`

