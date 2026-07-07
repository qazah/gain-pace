export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  graphql_public: {
    Tables: Record<never, never>;
    Views: Record<never, never>;
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
  public: {
    Tables: {
      garmin_credentials: {
        Row: {
          access_token: string;
          created_at: string;
          expires_at: string;
          garmin_password_encrypted: string | null;
          garmin_user_id: string | null;
          id: string;
          last_snapshot: Json | null;
          last_synced_at: string | null;
          refresh_token: string | null;
          session_data: Json | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          access_token: string;
          created_at?: string;
          expires_at: string;
          garmin_password_encrypted?: string | null;
          garmin_user_id?: string | null;
          id?: string;
          last_snapshot?: Json | null;
          last_synced_at?: string | null;
          refresh_token?: string | null;
          session_data?: Json | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          access_token?: string;
          created_at?: string;
          expires_at?: string;
          garmin_password_encrypted?: string | null;
          garmin_user_id?: string | null;
          id?: string;
          last_snapshot?: Json | null;
          last_synced_at?: string | null;
          refresh_token?: string | null;
          session_data?: Json | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      race_goals: {
        Row: {
          created_at: string;
          distance_km: number;
          event_date: string;
          event_name: string;
          id: string;
          is_active: boolean;
          target_finish_seconds: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          distance_km: number;
          event_date: string;
          event_name: string;
          id?: string;
          is_active?: boolean;
          target_finish_seconds: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          distance_km?: number;
          event_date?: string;
          event_name?: string;
          id?: string;
          is_active?: boolean;
          target_finish_seconds?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      workout_selections: {
        Row: {
          ai_explanation: string;
          alternative_rank: string;
          created_at: string;
          duration_minutes: number;
          garmin_data_snapshot: Json;
          id: string;
          modifier_feeling: string | null;
          modifier_intensity: string | null;
          modifier_time_available: number | null;
          race_goal_id: string | null;
          selected_date: string;
          training_arc_note: string | null;
          user_id: string;
          workout_type: string;
        };
        Insert: {
          ai_explanation: string;
          alternative_rank: string;
          created_at?: string;
          duration_minutes: number;
          garmin_data_snapshot?: Json;
          id?: string;
          modifier_feeling?: string | null;
          modifier_intensity?: string | null;
          modifier_time_available?: number | null;
          race_goal_id?: string | null;
          selected_date?: string;
          training_arc_note?: string | null;
          user_id: string;
          workout_type: string;
        };
        Update: {
          ai_explanation?: string;
          alternative_rank?: string;
          created_at?: string;
          duration_minutes?: number;
          garmin_data_snapshot?: Json;
          id?: string;
          modifier_feeling?: string | null;
          modifier_intensity?: string | null;
          modifier_time_available?: number | null;
          race_goal_id?: string | null;
          selected_date?: string;
          training_arc_note?: string | null;
          user_id?: string;
          workout_type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "workout_selections_race_goal_id_fkey";
            columns: ["race_goal_id"];
            isOneToOne: false;
            referencedRelation: "race_goals";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: Record<never, never>;
    Functions: Record<never, never>;
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const;
