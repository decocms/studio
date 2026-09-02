export interface Invitation {
  id: string;
  organizationId: string;
  organizationName?: string;
  organizationSlug?: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  inviterId: string;
  inviter?: {
    name?: string;
    email?: string;
    image?: string;
  };
}
